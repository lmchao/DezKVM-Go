/*
 * terminal-worker.js — off-main-thread screen reconstruction.
 *
 * Messages in:
 *   {type:'setcal', cal}            load a saved calibration (JSON)
 *   {type:'calibrate', lattice, reference}   two ImageBitmaps -> learn
 *   {type:'render', frame}          one ImageBitmap -> text grid
 * Messages out:
 *   {type:'ready'}
 *   {type:'calibrated', cal}        JSON calibration
 *   {type:'rendered', out}          {cols, rows, cells:Uint8Array}
 *   {type:'error', message}
 */
'use strict';
importScripts('terminal-core.js?v=4');

var canvas = null;
var ctx = null;
var cal = null;

function imageDataOf(bitmap) {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.clearRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

self.onmessage = function (e) {
  var msg = e.data;
  try {
    if (msg.type === 'setcal') {
      cal = TerminalCore.calFromJSON(msg.cal);
      self.postMessage({ type: 'ready', ok: !!cal });
      return;
    }
    if (msg.type === 'calibrate') {
      var lattice = imageDataOf(msg.lattice);
      var reference = imageDataOf(msg.reference);
      var c = TerminalCore.calibrate(lattice, reference);
      cal = c;
      self.postMessage({ type: 'calibrated', cal: TerminalCore.calToJSON(c) });
      return;
    }
    if (msg.type === 'render') {
      if (!cal) { self.postMessage({ type: 'error', message: 'no calibration' }); return; }
      var img = imageDataOf(msg.frame);
      var out = TerminalCore.render(img, cal);
      self.postMessage({ type: 'rendered', out: out }, [out.cells.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
