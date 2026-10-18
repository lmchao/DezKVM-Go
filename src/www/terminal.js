/*
 * terminal.js — Terminal tab for the DezKVM-Go local viewer.
 *
 * Video frames -> reconstructed text grid (Web Worker) -> xterm.js.
 * xterm.js input -> CH9329 HID over Web Serial (reuses local-kvm.js globals:
 * serialWriter, requestSerialPort, controller).
 */
(function () {
  'use strict';

  var CAL_KEY = 'dezkvm_terminal_cal_v1';
  var LATTICE_CMD = "awk 'BEGIN{for(i=0;i<80;i++){for(j=0;j<200;j++)printf \"X\";printf \"\\n\"}}'";
  var REFERENCE_CMD = "awk 'BEGIN{for(r=0;r<50;r++){for(c=32;c<=126;c++)printf \"%c\",c;printf \"\\n\"}}'";

  var worker = null;
  var term = null;
  var cal = null;            // JSON calibration (saved form)
  var active = false;
  var loopTimer = null;
  var rendering = false;
  var lastRows = null;
  var inputChain = Promise.resolve();
  var calibrating = false;

  // ---------- HID keymap: printable char -> [modifier, hid] ----------
  var HID = (function () {
    var m = new Map();
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < 26; i++) {
      m.set(letters[i], [0x00, 0x04 + i]);
      m.set(letters[i].toUpperCase(), [0x02, 0x04 + i]);
    }
    var digits = '1234567890';
    for (var d = 0; d < 10; d++) m.set(digits[d], [0x00, 0x1E + d]);
    var plain = {
      ' ': 0x2C, '-': 0x2D, '=': 0x2E, '[': 0x2F, ']': 0x30, '\\': 0x31,
      ';': 0x33, "'": 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38
    };
    for (var k in plain) m.set(k, [0x00, plain[k]]);
    var shifted = {
      '!': 0x1E, '@': 0x1F, '#': 0x20, '$': 0x21, '%': 0x22, '^': 0x23,
      '&': 0x24, '*': 0x25, '(': 0x26, ')': 0x27, '_': 0x2D, '+': 0x2E,
      '{': 0x2F, '}': 0x30, '|': 0x31, ':': 0x33, '"': 0x34, '~': 0x35,
      '<': 0x36, '>': 0x37, '?': 0x38
    };
    for (var s in shifted) m.set(s, [0x02, shifted[s]]);
    return m;
  })();

  function controlKey(code) {
    if (code === 0x0D || code === 0x0A) return [0x00, 0x28]; // Enter
    if (code === 0x7F || code === 0x08) return [0x00, 0x2A]; // Backspace
    if (code === 0x09) return [0x00, 0x2B];                  // Tab
    if (code === 0x1B) return [0x00, 0x29];                  // Esc
    if (code >= 0x01 && code <= 0x1A) return [0x01, 0x04 + (code - 1)]; // Ctrl+letter
    return null;
  }

  // ---------- serial ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function packet(mod, key) {
    var p = [0x57, 0xAB, 0x00, 0x02, 0x08, mod, 0x00, key, 0, 0, 0, 0, 0, 0];
    var sum = 0;
    for (var i = 0; i < 13; i++) sum += p[i];
    p[13] = sum & 0xFF;
    return new Uint8Array(p);
  }

  function hasSerial() {
    return typeof serialWriter !== 'undefined' && serialWriter != null;
  }

  async function writeBytes(bytes) {
    if (!hasSerial()) throw new Error('serial not connected');
    await serialWriter.write(bytes);
  }

  async function sendKey(mod, key, holdMs, gapMs) {
    await writeBytes(packet(mod, key));
    await sleep(holdMs == null ? 15 : holdMs);
    await writeBytes(packet(0x00, 0x00));
    await sleep(gapMs == null ? 5 : gapMs);
  }

  async function typeText(str, holdMs, gapMs) {
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      var code = ch.charCodeAt(0);
      if (code === 0x0D || code === 0x0A) {
        await sendKey(0x00, 0x28, holdMs, gapMs);
        continue;
      }
      if (code < 0x20 || code > 0x7E) continue;
      var k = HID.get(ch);
      if (k) await sendKey(k[0], k[1], holdMs, gapMs);
    }
  }

  async function ensureSerial() {
    if (hasSerial()) return true;
    if (typeof requestSerialPort === 'function') {
      try { await requestSerialPort(); } catch (e) {}
    }
    return hasSerial();
  }

  async function resetChip() {
    await writeBytes(new Uint8Array([0x57, 0xAB, 0x00, 0x0F, 0x00, 0x11]));
  }

  // ---------- status / tab ----------
  function setStatus(msg) {
    var el = document.getElementById('terminalStatus');
    if (el) el.textContent = msg;
  }

  function applyFit() {
    if (!term) return;
    var el = document.getElementById('terminal');
    if (!el) return;
    var cols = term.cols || 240;
    var rows = term.rows || 67;
    // Account for #terminal padding (6px each side, 4px top/bottom).
    var availW = Math.max(80, el.clientWidth - 12);
    var availH = Math.max(60, el.clientHeight - 8);
    // xterm's monospace cell is roughly 0.6em wide and 1.2em tall.
    var fsW = Math.floor(availW / (cols * 0.6));
    var fsH = Math.floor(availH / (rows * 1.2));
    var fs = Math.max(4, Math.min(fsW, fsH)); // fit BOTH dimensions
    if (term.options.fontSize !== fs) term.options.fontSize = fs;
  }

  // ---------- xterm ----------
  function initXterm() {
    if (term) return;
    var host = document.getElementById('terminal');
    if (!host || typeof Terminal === 'undefined') return;
    term = new Terminal({
      cols: 240,
      rows: 67,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 10,
      theme: { background: '#000000', foreground: '#e0e0e0' },
      cursorBlink: false,
      scrollback: 0,
      convertEol: false
    });
    term.open(host);
    term.write('\x1b[?25l');
    term.onData(function (data) {
      if (!active) return;
      inputChain = inputChain
        .then(function () { return forwardData(data); })
        .catch(function (e) { setStatus('input: ' + e.message); });
    });
    applyFit();
  }

  async function forwardData(data) {
    for (var i = 0; i < data.length; i++) {
      var code = data.charCodeAt(i);
      if (code >= 0x20 && code <= 0x7E) {
        var k = HID.get(data[i]);
        if (k) await sendKey(k[0], k[1], 15, 4);
      } else {
        var c = controlKey(code);
        if (c) await sendKey(c[0], c[1], 15, 4);
      }
    }
  }

  function writeGrid(out) {
    if (!term) return;
    if (!lastRows || lastRows.length !== out.rows) {
      term.resize(out.cols, out.rows);
      term.write('\x1b[2J\x1b[H\x1b[?25l');
      lastRows = new Array(out.rows).fill(null);
      applyFit();
    }
    for (var r = 0; r < out.rows; r++) {
      var s = '';
      for (var c = 0; c < out.cols; c++) s += String.fromCharCode(out.cells[r * out.cols + c]);
      s = s.replace(/\s+$/, '');
      if (lastRows[r] === s) continue;
      term.write('\x1b[' + (r + 1) + ';1H' + s + '\x1b[K');
      lastRows[r] = s;
    }
  }

  // ---------- frame loop ----------
  async function frameTick() {
    if (!active || !cal || rendering || calibrating) return;
    var video = document.getElementById('video');
    if (!video || !video.srcObject) return;
    try {
      var bitmap = await createImageBitmap(video);
      rendering = true;
      worker.postMessage({ type: 'render', frame: bitmap }, [bitmap]);
    } catch (e) {
      rendering = false;
    }
  }
  function startLoop() {
    stopLoop();
    loopTimer = setInterval(frameTick, 250);
    frameTick();
  }
  function stopLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  }

  // ---------- calibration ----------
  async function captureBitmap() {
    var video = document.getElementById('video');
    if (!video || !video.srcObject) throw new Error('no video stream');
    return createImageBitmap(video);
  }

  async function calibrate() {
    if (calibrating) return;
    calibrating = true;
    stopLoop();
    try {
      setStatus('Calibrating: connect serial...');
      if (!(await ensureSerial())) { setStatus('Serial not connected'); return; }

      setStatus('Calibrating: warm-up...');
      try { await resetChip(); } catch (e) {}
      await sleep(1500);

      setStatus('Calibrating: lattice...');
      await sendKey(0x01, 0x0F, 30, 30); // Ctrl+L
      await sleep(300);
      await typeText(LATTICE_CMD, 25, 8);
      await sendKey(0x00, 0x28, 30, 30); // Enter
      await sleep(1200);
      var lattice = await captureBitmap();

      setStatus('Calibrating: reference glyphs...');
      await sendKey(0x01, 0x0F, 30, 30);
      await sleep(300);
      await typeText(REFERENCE_CMD, 25, 8);
      await sendKey(0x00, 0x28, 30, 30);
      await sleep(1200);
      var reference = await captureBitmap();

      setStatus('Calibrating: learning glyphs...');
      worker.postMessage({ type: 'calibrate', lattice: lattice, reference: reference }, [lattice, reference]);
    } catch (e) {
      setStatus('Calibration failed: ' + e.message);
      calibrating = false;
      if (active && cal) startLoop();
    }
  }

  function onCalibrated(json) {
    calibrating = false;
    cal = json;
    lastRows = null;
    try { localStorage.setItem(CAL_KEY, JSON.stringify(json)); } catch (e) {}
    setStatus('Terminal ready — ' + json.cols + 'x' + json.rows + ', cell ' + json.cellW + 'x' + json.cellH);
    worker.postMessage({ type: 'setcal', cal: json });
    if (active) startLoop();
  }

  // ---------- show/hide ----------
  function show(mode) {
    var panel = document.getElementById('terminalPanel');
    var btn = document.getElementById('btnTerminalView');
    if (!panel) return;
    if (mode === 'terminal') {
      active = true;
      panel.classList.add('visible');
      document.body.classList.add('terminal-active');
      if (btn) btn.classList.add('negative');
      initXterm();
      setTimeout(applyFit, 50);
      if (cal) {
        setStatus('Terminal ready — ' + cal.cols + 'x' + cal.rows + ', cell ' + cal.cellW + 'x' + cal.cellH);
        startLoop();
      } else {
        setStatus('Not calibrated — go to a shell prompt, then click Calibrate');
      }
    } else {
      active = false;
      panel.classList.remove('visible');
      document.body.classList.remove('terminal-active');
      if (btn) btn.classList.remove('negative');
      stopLoop();
    }
  }

  // ---------- init ----------
  function init() {
    if (typeof Worker === 'undefined' || typeof TerminalCore === 'undefined') return;

    worker = new Worker('terminal-worker.js');
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'calibrated') onCalibrated(m.cal);
      else if (m.type === 'rendered') { rendering = false; writeGrid(m.out); }
      else if (m.type === 'ready') { /* calibration loaded */ }
      else if (m.type === 'error') { rendering = false; setStatus('worker: ' + m.message); }
    };

    try {
      var raw = localStorage.getItem(CAL_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (TerminalCore.calFromJSON(obj)) {
          cal = obj;
          worker.postMessage({ type: 'setcal', cal: obj });
        }
      }
    } catch (e) { /* ignore malformed cache */ }

    var btnT = document.getElementById('btnTerminalView');
    if (btnT) btnT.addEventListener('click', function () {
      var panel = document.getElementById('terminalPanel');
      show(panel && panel.classList.contains('visible') ? 'video' : 'terminal');
    });
    var btnB = document.getElementById('btnTerminalBack');
    if (btnB) btnB.addEventListener('click', function () { show('video'); });
    var btnC = document.getElementById('btnTerminalCalibrate');
    if (btnC) btnC.addEventListener('click', function () { calibrate(); });

    window.addEventListener('resize', function () { if (active) applyFit(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
