// Package screen reconstructs a monospace terminal's text from captured video
// frames. It works in three phases:
//
//  1. Calibrate: detect the terminal's cell grid (width, height, origin) and
//     learn a glyph template for each printable ASCII character from a
//     reference frame that the caller prints to the remote terminal.
//  2. Render: binarize a frame, slice it into cells, and match each cell's
//     bitmap against the learned glyph templates to recover the character.
//
// The result is a plain text grid (rows × cols) that can be diffed and
// displayed like a normal terminal.
package screen

import (
	"image"
	"math/bits"
)

// Calibration holds the detected grid geometry and the learned glyph set.
type Calibration struct {
	CellW, CellH     int
	OriginX, OriginY int
	Cols, Rows       int
	imgW, imgH       int
	Threshold        uint8 // brightness threshold used for binarization
	Dark             bool  // true: bright text on dark background
	glyphs           map[byte]*glyph
}

// Text is one rendered frame of the terminal, as a character grid.
type Text struct {
	Cols, Rows int
	Chars      [][]byte // Chars[r][c]
}

// glyph is a binarized cell bitmap (one uint64 per row, cellW bits wide).
type glyph struct {
	w, h int
	rows []uint64
}

// ---- color / binarization ----

func brightness(r, g, b uint8) uint8 {
	if r >= g && r >= b {
		return r
	}
	if g >= b {
		return g
	}
	return b
}

// detectThreshold finds a brightness threshold that separates the terminal's
// background from its text, plus the polarity (dark background = bright text).
//
// The threshold is the midpoint between the background and the mean text
// brightness, biased 40% of the way toward the background. It is used for grid
// detection and polarity at calibration; render() ignores it in favour of a
// per-cell adaptive threshold (see cellGlyph).
func detectThreshold(img *image.RGBA) (thr uint8, dark bool) {
	var hist [256]int
	for i := 0; i < len(img.Pix); i += 4 {
		hist[brightness(img.Pix[i], img.Pix[i+1], img.Pix[i+2])]++
	}

	bg := 0
	for i := 1; i < 256; i++ {
		if hist[i] > hist[bg] {
			bg = i
		}
	}
	dark = bg < 128

	var sum, cnt int64
	for b := 0; b < 256; b++ {
		if hist[b] == 0 {
			continue
		}
		if dark && b > bg {
			sum += int64(b) * int64(hist[b])
			cnt += int64(hist[b])
		} else if !dark && b < bg {
			sum += int64(b) * int64(hist[b])
			cnt += int64(hist[b])
		}
	}
	if cnt == 0 {
		if dark {
			return uint8(bg + 40), true
		}
		return uint8(bg - 40), false
	}
	fg := int(sum / cnt)
	// Bias the threshold toward the background: 40% of the way from bg to the
	// mean text brightness instead of the 50% midpoint. The midpoint sits too
	// close to dim colored text (e.g. `ip`'s dark-blue addresses), whose
	// strokes peak well below white and get clipped by the midpoint threshold.
	return uint8(bg + (fg-bg)*2/5), dark
}

// binarize converts an image to a 1-bit ink mask using a fixed threshold.
func binarize(img *image.RGBA, thr uint8, dark bool) []uint8 {
	mask := make([]uint8, len(img.Pix)/4)
	for i := 0; i < len(img.Pix); i += 4 {
		b := brightness(img.Pix[i], img.Pix[i+1], img.Pix[i+2])
		ink := b >= thr
		if !dark {
			ink = b <= thr
		}
		if ink {
			mask[i/4] = 1
		}
	}
	return mask
}

// ---- grid detection ----

func colProjection(mask []uint8, w, y0, y1 int) []int {
	p := make([]int, w)
	for y := y0; y < y1; y++ {
		row := mask[y*w : (y+1)*w]
		for x, v := range row {
			p[x] += int(v)
		}
	}
	return p
}

func rowProjection(mask []uint8, w, h, x0, x1 int) []int {
	p := make([]int, h)
	for y := 0; y < h; y++ {
		for x := x0; x < x1; x++ {
			p[y] += int(mask[y*w+x])
		}
	}
	return p
}

// autocorrPitch finds the dominant period of a projection via normalized
// autocorrelation, searching lags in [minPitch, maxPitch].
func autocorrPitch(proj []int, minPitch, maxPitch int) int {
	bestPitch, bestScore := 0, -1.0
	for k := minPitch; k <= maxPitch; k++ {
		var sum int64
		n := 0
		for i := 0; i+k < len(proj); i++ {
			sum += int64(proj[i]) * int64(proj[i+k])
			n++
		}
		if n == 0 {
			continue
		}
		score := float64(sum) / float64(n)
		if score > bestScore {
			bestScore, bestPitch = score, k
		}
	}
	return bestPitch
}

// detectGrid measures cellW and cellH from a binarized frame full of evenly
// spaced monospace text (e.g. a lattice of repeated characters).
func detectGrid(mask []uint8, w, h int) (cellW, cellH int) {
	vp := colProjection(mask, w, 0, h)
	hp := rowProjection(mask, w, h, 0, w)
	cellW = autocorrPitch(vp, 4, 24)
	cellH = autocorrPitch(hp, 8, 40)
	return cellW, cellH
}

// detectPhase finds the grid origin (px, py) within one cell such that glyphs
// are centered in their cells. It minimizes the ink that falls exactly on the
// grid lines, which only happens when the lines sit in the padding between
// glyphs (i.e. at the true cell boundaries).
func detectPhase(mask []uint8, w, h, cellW, cellH int) (px, py int) {
	bestScore := int(^uint(0) >> 1)
	for oy := 0; oy < cellH; oy++ {
		for ox := 0; ox < cellW; ox++ {
			score := 0
			for x := ox; x < w; x += cellW {
				for y := 0; y < h; y++ {
					score += int(mask[y*w+x])
				}
			}
			for y := oy; y < h; y += cellH {
				for x := 0; x < w; x++ {
					score += int(mask[y*w+x])
				}
			}
			if score < bestScore {
				bestScore = score
				px, py = ox, oy
			}
		}
	}
	return px, py
}

// ---- glyph extraction and matching ----

func extractGlyph(mask []uint8, imgW, x0, y0, cw, ch int) glyph {
	g := glyph{w: cw, h: ch, rows: make([]uint64, ch)}
	for r := 0; r < ch; r++ {
		var row uint64
		base := (y0 + r) * imgW
		for c := 0; c < cw; c++ {
			if mask[base+x0+c] != 0 {
				row |= 1 << uint(c)
			}
		}
		g.rows[r] = row
	}
	return g
}

// cellGlyph extracts a cell from the raw image using an adaptive, per-cell
// threshold (midpoint of the cell's own brightness range). A fixed global
// threshold clips dim colored text (e.g. `ip`'s dark-blue addresses); matching
// at the cell's own midpoint makes dim text binarize like white text. ok is
// false for a blank cell.
func cellGlyph(img *image.RGBA, x0, y0, cw, ch int, dark bool) (glyph, bool) {
	mn, mx := 255, 0
	for r := 0; r < ch; r++ {
		base := img.PixOffset(x0, y0+r)
		for c := 0; c < cw; c++ {
			p := base + c*4
			b := int(brightness(img.Pix[p], img.Pix[p+1], img.Pix[p+2]))
			if b < mn {
				mn = b
			}
			if b > mx {
				mx = b
			}
		}
	}
	if mx-mn < 48 {
		return glyph{}, false
	}
	thr := (mn + mx) / 2
	g := glyph{w: cw, h: ch, rows: make([]uint64, ch)}
	for r := 0; r < ch; r++ {
		base := img.PixOffset(x0, y0+r)
		var row uint64
		for c := 0; c < cw; c++ {
			p := base + c*4
			b := int(brightness(img.Pix[p], img.Pix[p+1], img.Pix[p+2]))
			on := dark && b >= thr || !dark && b <= thr
			if on {
				row |= 1 << uint(c)
			}
		}
		g.rows[r] = row
	}
	return g, true
}

func (g glyph) inkCount() int {
	n := 0
	for _, r := range g.rows {
		n += bits.OnesCount64(r)
	}
	return n
}

// isCursor reports whether the glyph is a console cursor artifact — an
// underline confined to the bottom rows, or a nearly filled block — rather
// than a printable character.
func (g glyph) isCursor() bool {
	total, bottom := 0, 0
	for r, row := range g.rows {
		n := bits.OnesCount64(row)
		total += n
		if r >= g.h-2 {
			bottom += n
		}
	}
	if total == 0 {
		return false
	}
	if total >= g.w*g.h*7/10 {
		return true
	}
	return bottom == total && total >= g.w/2
}

func glyphDistance(a, b glyph) int {
	if a.w != b.w || a.h != b.h {
		return int(^uint(0) >> 2)
	}
	d := 0
	for i := range a.rows {
		d += bits.OnesCount64(a.rows[i] ^ b.rows[i])
	}
	return d
}

// shiftH returns the glyph moved dx pixels horizontally (+1 = right), clipped
// to the cell. A drifting text grid means a cell can be a shifted copy of the
// learned template.
func (g glyph) shiftH(dx int) glyph {
	out := glyph{w: g.w, h: g.h, rows: make([]uint64, len(g.rows))}
	var mask uint64 = ^uint64(0)
	if g.w < 64 {
		mask = (uint64(1) << uint(g.w)) - 1
	}
	for i, row := range g.rows {
		if dx > 0 {
			out.rows[i] = (row << uint(dx)) & mask
		} else {
			out.rows[i] = row >> uint(-dx)
		}
	}
	return out
}

// glyphDistanceBounded stops as soon as it cannot beat cut.
func glyphDistanceBounded(a, b glyph, cut int) int {
	if a.w != b.w || a.h != b.h {
		return int(^uint(0) >> 2)
	}
	d := 0
	for i := range a.rows {
		d += bits.OnesCount64(a.rows[i] ^ b.rows[i])
		if d > cut {
			return d
		}
	}
	return d
}

// ---- calibration assembly ----

// buildCalibration finalizes a Calibration from measured geometry, ready to
// accept learned glyphs.
func buildCalibration(imgW, imgH, cellW, cellH, px, py int, thr uint8, dark bool) *Calibration {
	return &Calibration{
		CellW:     cellW,
		CellH:     cellH,
		OriginX:   px,
		OriginY:   py,
		Cols:      imgW / cellW,
		Rows:      imgH / cellH,
		imgW:      imgW,
		imgH:      imgH,
		Threshold: thr,
		Dark:      dark,
		glyphs:    make(map[byte]*glyph),
	}
}

// LearnGlyph stores a glyph template for a character code.
func (c *Calibration) LearnGlyph(code byte, g glyph) {
	gc := g
	c.glyphs[code] = &gc
}

// glyphTpl bundles a learned glyph with its drift-shifted variants so the
// per-cell matcher does not rebuild them for every cell of every frame.
type glyphTpl struct {
	code       byte
	base, l, r glyph
	ink        int
}

func newGlyphTpl(code byte, g glyph) glyphTpl {
	return glyphTpl{
		code: code,
		base: g,
		l:    g.shiftH(-1),
		r:    g.shiftH(1),
		ink:  g.inkCount(),
	}
}

// Render converts a captured frame into a text grid by matching every cell
// against the learned glyphs. Cells are binarized with an adaptive per-cell
// threshold (see cellGlyph), so dim colored text decodes like white text.
func (c *Calibration) Render(img *image.RGBA) *Text {
	tpls := make([]glyphTpl, 0, len(c.glyphs))
	for code, g := range c.glyphs {
		tpls = append(tpls, newGlyphTpl(code, *g))
	}

	t := &Text{Cols: c.Cols, Rows: c.Rows, Chars: make([][]byte, c.Rows)}

	for r := 0; r < c.Rows; r++ {
		t.Chars[r] = make([]byte, c.Cols)
		for col := 0; col < c.Cols; col++ {
			x0 := c.OriginX + col*c.CellW
			y0 := c.OriginY + r*c.CellH
			g, ok := cellGlyph(img, x0, y0, c.CellW, c.CellH, c.Dark)
			code := byte(' ')
			if ok {
				code = matchGlyph(g, tpls)
			}
			if code == 0 {
				code = '?'
			}
			t.Chars[r][col] = code
		}
	}
	return t
}

// matchGlyph returns the best character for a cell bitmap, ' ' when the cell
// is blank, '?' when nothing matches.
func matchGlyph(g glyph, tpls []glyphTpl) byte {
	ink := g.inkCount()
	if ink == 0 {
		return ' '
	}
	if g.isCursor() {
		return '_'
	}

	bestCode := byte('?')
	bestDist := int(^uint(0) >> 1)
	for _, tp := range tpls {
		if abs(tp.ink-ink) > ink/2+2 {
			continue
		}
		if d := glyphDistance(g, tp.base); d < bestDist {
			bestDist, bestCode = d, tp.code
		}
	}
	// Tolerate one pixel of horizontal drift: video scaling and sub-pixel cell
	// widths slide the grid across a long line, so thin glyphs (digits, '.')
	// match a neighbouring character or nothing at all.
	if bestDist > 0 {
		for _, tp := range tpls {
			if abs(tp.ink-ink) > ink/2+2 {
				continue
			}
			if d := glyphDistanceBounded(g, tp.l, bestDist); d < bestDist {
				bestDist, bestCode = d, tp.code
			}
			if d := glyphDistanceBounded(g, tp.r, bestDist); d < bestDist {
				bestDist, bestCode = d, tp.code
			}
		}
	}
	if bestDist > max(2, ink/3) {
		return '?'
	}
	return bestCode
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
