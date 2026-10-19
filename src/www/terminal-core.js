/*
 * terminal-core.js — reconstruct a text grid from a video frame.
 *
 * A browser-side port of kvmterm/screen (Go): binarize -> detect the monospace
 * grid (autocorrelation + phase) -> match each cell against learned glyphs.
 *
 * Pure functions over an ImageData-like {data: Uint8ClampedArray, width, height}.
 * No DOM / canvas here, so the Web Worker and Node tests can share it.
 *
 * Exposes (global `TerminalCore` or module.exports):
 *   binarize, detectThreshold, detectGrid, detectPhase, leftEdgePhase,
 *   findReferenceStart, learnGlyphs, render, calibrate, calToJSON, calFromJSON
 */
(function (root) {
  'use strict';

  function brightness(r, g, b) {
    return r >= g ? (r >= b ? r : b) : (g >= b ? g : b);
  }

  function binarize(img, thr, dark) {
    const data = img.data, n = img.width * img.height;
    const mask = new Uint8Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const b = brightness(data[i], data[i + 1], data[i + 2]);
      if (dark ? b >= thr : b <= thr) mask[p] = 1;
    }
    return mask;
  }

  // Background = most common brightness; threshold = 40% of the way from
  // background toward the mean text brightness. Used for grid detection and
  // polarity at calibration; render() instead uses a per-cell adaptive
  // threshold (see cellGlyph).
  function detectThreshold(img) {
    const data = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      hist[brightness(data[i], data[i + 1], data[i + 2])]++;
    }
    let bg = 0;
    for (let i = 1; i < 256; i++) if (hist[i] > hist[bg]) bg = i;
    const dark = bg < 128;
    let sum = 0, cnt = 0;
    for (let b = 0; b < 256; b++) {
      if (!hist[b]) continue;
      if ((dark && b > bg) || (!dark && b < bg)) { sum += b * hist[b]; cnt += hist[b]; }
    }
    let thr;
    if (!cnt) thr = dark ? Math.min(255, bg + 40) : Math.max(0, bg - 40);
    else {
      const textMean = Math.round(sum / cnt);
      // Bias toward the background (40% instead of the 50% midpoint): the
      // midpoint clips dim colored text (e.g. `ip`'s dark-blue addresses),
      // whose strokes peak well below white.
      thr = Math.round(bg + (textMean - bg) * 2 / 5);
    }
    return { thr: thr, dark: dark };
  }

  function colProjection(mask, w, y0, y1) {
    const p = new Int32Array(w);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) p[x] += mask[row + x];
    }
    return p;
  }

  function rowProjection(mask, w, h) {
    const p = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let x = 0; x < w; x++) s += mask[row + x];
      p[y] = s;
    }
    return p;
  }

  function autocorrPitch(proj, minPitch, maxPitch) {
    let bestPitch = minPitch, bestScore = -1;
    for (let k = minPitch; k <= maxPitch; k++) {
      let sum = 0, n = 0;
      for (let i = 0; i + k < proj.length; i++) { sum += proj[i] * proj[i + k]; n++; }
      if (!n) continue;
      const score = sum / n;
      if (score > bestScore) { bestScore = score; bestPitch = k; }
    }
    return bestPitch;
  }

  function detectGrid(mask, w, h) {
    const vp = colProjection(mask, w, 0, h);
    const hp = rowProjection(mask, w, h);
    return {
      cellW: autocorrPitch(vp, 4, 24),
      cellH: autocorrPitch(hp, 8, 40),
    };
  }

  // Choose the origin within a cell that minimises ink on the grid lines.
  // Uses projections, so it is cheap.
  function detectPhase(mask, w, h, cellW, cellH) {
    const vp = colProjection(mask, w, 0, h);
    const hp = rowProjection(mask, w, h);
    let best = Infinity, bx = 0, by = 0;
    for (let oy = 0; oy < cellH; oy++) {
      let sy = 0;
      for (let y = oy; y < h; y += cellH) sy += hp[y];
      for (let ox = 0; ox < cellW; ox++) {
        let sx = 0;
        for (let x = ox; x < w; x += cellW) sx += vp[x];
        const score = sx + sy;
        if (score < best) { best = score; bx = ox; by = oy; }
      }
    }
    return { px: bx, py: by };
  }

  // The boundary-ink minimiser can land on the font's inter-glyph blank column
  // instead of the true cell edge (an off-by-one). Realign to the leftmost
  // glyph edge, as kvmterm does.
  function leftEdgePhase(mask, w, h, cellW) {
    const vp = colProjection(mask, w, 0, h);
    for (let x = 0; x < w; x++) if (vp[x] > 0) return x % cellW;
    return 0;
  }

  function extractGlyph(mask, w, x0, y0, cw, ch) {
    const rows = new Uint32Array(ch);
    for (let r = 0; r < ch; r++) {
      let bits = 0;
      const base = (y0 + r) * w + x0;
      for (let c = 0; c < cw && c < 32; c++) {
        if (mask[base + c]) bits |= (1 << c);
      }
      rows[r] = bits >>> 0;
    }
    return rows;
  }

  // Extract a cell from a grayscale/RGBA image using an adaptive, per-cell
  // threshold (midpoint of the cell's own brightness range). This is what
  // makes dim colored text (e.g. `ip`'s dark-blue addresses) decode the same
  // as white text: a fixed global threshold clips the dim strokes. Returns
  // null when the cell is blank (no contrast).
  function cellGlyph(img, w, x0, y0, cw, ch, dark) {
    let mn = 255, mx = 0;
    for (let r = 0; r < ch; r++) {
      const base = (y0 + r) * w + x0;
      for (let c = 0; c < cw; c++) {
        const p = (base + c) * 4;
        const b = brightness(img.data[p], img.data[p + 1], img.data[p + 2]);
        if (b < mn) mn = b;
        if (b > mx) mx = b;
      }
    }
    if (mx - mn < 48) return null; // blank
    const thr = (mn + mx) >> 1;
    const rows = new Uint32Array(ch);
    for (let r = 0; r < ch; r++) {
      const base = (y0 + r) * w + x0;
      let bits = 0;
      for (let c = 0; c < cw && c < 32; c++) {
        const p = (base + c) * 4;
        const b = brightness(img.data[p], img.data[p + 1], img.data[p + 2]);
        if (dark ? b >= thr : b <= thr) bits |= (1 << c);
      }
      rows[r] = bits >>> 0;
    }
    return rows;
  }

  function glyphInk(rows) {
    let n = 0;
    for (let i = 0; i < rows.length; i++) n += popcount32(rows[i]);
    return n;
  }

  function glyphDistance(a, b) {
    if (a.length !== b.length) return 1 << 30;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += popcount32((a[i] ^ b[i]) >>> 0);
    return d;
  }

  // Shift a glyph horizontally by dx pixels (+1 = right). Video scaling and
  // sub-pixel cell widths drift the text grid by a pixel across a long line,
  // so a cell can be a shifted copy of the learned template.
  function shiftGlyph(rows, dx, cw) {
    const out = new Uint32Array(rows.length);
    const mask = cw >= 32 ? 0xffffffff : ((1 << cw) - 1) >>> 0;
    for (let i = 0; i < rows.length; i++) {
      out[i] = dx > 0 ? ((rows[i] << dx) & mask) >>> 0 : (rows[i] >>> -dx);
    }
    return out;
  }

  // Distance with early abandon: stops as soon as it can no longer beat `cut`.
  function glyphDistanceBounded(a, b, cut) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      d += popcount32((a[i] ^ b[i]) >>> 0);
      if (d > cut) return d;
    }
    return d;
  }

  function popcount32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >>> 24;
  }

  // The console cursor is a graphics artifact (underline or block), not a
  // printable glyph. Detect it so it renders as '_' instead of '?'.
  function isCursorCell(rows, cw, ch) {
    let total = 0, bottom = 0;
    for (let r = 0; r < ch; r++) {
      const n = popcount32(rows[r]);
      total += n;
      if (r >= ch - 2) bottom += n;
    }
    if (total === 0) return false;
    // block cursor: most of the cell inked
    if (total >= cw * ch * 0.7) return true;
    // underline cursor: ink only in the bottom two rows, at least half width
    if (bottom === total && total >= cw * 0.5) return true;
    return false;
  }

  // First reference row that equals the row below it (the reference grid is a
  // stack of identical rows).
  function findReferenceStart(mask, w, h, cellW, cellH, px, py) {
    const rows = Math.floor(h / cellH);
    for (let r = 0; r < rows - 1; r++) {
      let same = 0, total = 0;
      for (let c = 0; c <= 94; c++) {
        const g1 = extractGlyph(mask, w, px + c * cellW, py + r * cellH, cellW, cellH);
        const g2 = extractGlyph(mask, w, px + c * cellW, py + (r + 1) * cellH, cellW, cellH);
        if (glyphDistance(g1, g2) <= 2) same++;
        total++;
      }
      if (total && same / total > 0.9) return r;
    }
    return 1;
  }

  // Learn glyphs 32..126 from the reference row, using the same per-cell
  // adaptive threshold as render() so the templates match dim text.
  function learnGlyphs(img, w, cellW, cellH, px, py, refRow, dark) {
    const glyphs = [];
    for (let c = 0; c <= 94; c++) {
      const rows = cellGlyph(img, w, px + c * cellW, py + refRow * cellH, cellW, cellH, dark);
      if (!rows) {
        glyphs.push({ code: 32 + c, rows: new Uint32Array(cellH), ink: 0 });
        continue;
      }
      glyphs.push({ code: 32 + c, rows: Array.from(rows), ink: glyphInk(rows) });
    }
    return glyphs;
  }

  // Match every cell against the glyph set. Returns {cols, rows, cells}
  // where cells is a flat Uint8Array of character codes.
  //
  // Cells are binarized with a per-cell adaptive threshold (midpoint of the
  // cell's own brightness range) rather than the fixed calibration threshold,
  // so dim colored text (e.g. a colored `ip` address) decodes like white text.
  function render(img, cal) {
    const cellW = cal.cellW, cellH = cal.cellH;
    const ox = cal.originX, oy = cal.originY;
    const cols = cal.cols, rows = cal.rows;
    const glyphs = cal.glyphs;
    const cells = new Uint8Array(cols * rows);
    const dark = cal.dark;

    function match(rowsBits, ink) {
      if (ink === 0) return 32;
      if (isCursorCell(rowsBits, cellW, cellH)) return 95 /* '_' */;

      let bestCode = 63 /* '?' */, bestDist = 1 << 30;
      for (let g = 0; g < glyphs.length; g++) {
        const gl = glyphs[g];
        // cheap prefilter: very different ink mass cannot match well
        if (Math.abs(gl.ink - ink) > ink / 2 + 2) continue;
        let d = 0;
        const gr = gl.rows;
        for (let i = 0; i < rowsBits.length; i++) d += popcount32((rowsBits[i] ^ gr[i]) >>> 0);
        if (d < bestDist) { bestDist = d; bestCode = gl.code; }
      }
      // Tolerate one pixel of horizontal drift: retry against left/right
      // shifted templates. Video scaling and sub-pixel cell widths slide the
      // grid by a pixel across a long line, and thin glyphs (digits, '.')
      // then match a *neighbouring* character or nothing at all.
      if (bestDist > 0) {
        for (let g = 0; g < glyphs.length; g++) {
          const gl = glyphs[g];
          if (Math.abs(gl.ink - ink) > ink / 2 + 2) continue;
          if (!gl.rowsL) { gl.rowsL = shiftGlyph(gl.rows, 1, cellW); gl.rowsR = shiftGlyph(gl.rows, -1, cellW); }
          const dl = glyphDistanceBounded(rowsBits, gl.rowsL, bestDist);
          if (dl < bestDist) { bestDist = dl; bestCode = gl.code; }
          const dr = glyphDistanceBounded(rowsBits, gl.rowsR, bestDist);
          if (dr < bestDist) { bestDist = dr; bestCode = gl.code; }
        }
      }
      if (bestDist > Math.max(2, Math.floor(ink / 3))) return -1; // reject
      return bestCode;
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rowsBits = cellGlyph(img, img.width, ox + c * cellW, oy + r * cellH, cellW, cellH, dark);
        let code = rowsBits === null ? 32 : match(rowsBits, glyphInk(rowsBits));
        if (code <= 0) code = 63;
        cells[r * cols + c] = code;
      }
    }
    return { cols: cols, rows: rows, cells: cells };
  }

  // Full calibration from a lattice frame + a reference frame.
  function calibrate(lattice, reference) {
    const th = detectThreshold(lattice);
    const mask = binarize(lattice, th.thr, th.dark);
    const w = lattice.width, h = lattice.height;
    const grid = detectGrid(mask, w, h);
    const cellW = grid.cellW, cellH = grid.cellH;
    if (cellW < 4 || cellW > 24 || cellH < 8 || cellH > 40) {
      throw new Error('grid detection failed (cell ' + cellW + 'x' + cellH + ')');
    }
    const phase = detectPhase(mask, w, h, cellW, cellH);
    const px = leftEdgePhase(mask, w, h, cellW);
    const py = phase.py;

    const rmask = binarize(reference, th.thr, th.dark);
    const rw = reference.width, rh = reference.height;
    const refRow = findReferenceStart(rmask, rw, rh, cellW, cellH, px, py);

    return {
      cellW: cellW, cellH: cellH,
      originX: px, originY: py,
      threshold: th.thr, dark: th.dark,
      cols: Math.floor(rw / cellW),
      rows: Math.floor(rh / cellH),
      refRow: refRow,
      glyphs: learnGlyphs(reference, rw, cellW, cellH, px, py, refRow, th.dark),
    };
  }

  // JSON-safe calibration (Uint32 rows -> plain arrays).
  function calToJSON(cal) {
    return {
      v: 1,
      cellW: cal.cellW, cellH: cal.cellH,
      originX: cal.originX, originY: cal.originY,
      threshold: cal.threshold, dark: cal.dark,
      cols: cal.cols, rows: cal.rows,
      glyphs: cal.glyphs.map(function (g) {
        return { code: g.code, rows: g.rows, ink: g.ink };
      }),
    };
  }

  function calFromJSON(obj) {
    if (!obj || obj.v !== 1) return null;
    return {
      cellW: obj.cellW, cellH: obj.cellH,
      originX: obj.originX, originY: obj.originY,
      threshold: obj.threshold, dark: obj.dark,
      cols: obj.cols, rows: obj.rows,
      glyphs: obj.glyphs.map(function (g) {
        return { code: g.code, rows: Uint32Array.from(g.rows), ink: g.ink };
      }),
    };
  }

  const api = {
    binarize: binarize,
    detectThreshold: detectThreshold,
    detectGrid: detectGrid,
    detectPhase: detectPhase,
    leftEdgePhase: leftEdgePhase,
    findReferenceStart: findReferenceStart,
    learnGlyphs: learnGlyphs,
    render: render,
    calibrate: calibrate,
    calToJSON: calToJSON,
    calFromJSON: calFromJSON,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TerminalCore = api;
})(typeof self !== 'undefined' ? self : this);
