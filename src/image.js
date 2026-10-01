// Turns a Google Drive image into something Instagram will accept.
//
// Instagram's rules (from the Make/Instagram module):
//   - JPEG only              (our Drive images are often PNG)
//   - aspect ratio 4:5 .. 1.91:1
//   - width 320 .. 1440
//   - max 8 MB
//
// Anything outside those rules is padded onto a white canvas instead of being cropped,
// so no part of the Quran/Hadees text is ever cut off.
const { log } = require('./util');

const MIN_RATIO = 4 / 5;      // 0.8  (tall limit)
const MAX_RATIO = 1.91;       // wide limit
const MAX_WIDTH = 1440;
const MIN_WIDTH = 320;
const MAX_BYTES = 8 * 1024 * 1024;

let sharp = null;
function lib() {
  if (sharp === null) {
    try { sharp = require('sharp'); } catch { sharp = false; }
  }
  return sharp;
}

// Works out the canvas the image has to sit on so the ratio is allowed
function canvas(w, h) {
  const ratio = w / h;
  let cw = w;
  let ch = h;
  if (ratio < MIN_RATIO) cw = Math.round(h * MIN_RATIO);        // too tall  -> widen
  else if (ratio > MAX_RATIO) ch = Math.round(cw / MAX_RATIO);  // too wide  -> heighten
  if (cw > MAX_WIDTH) { ch = Math.round((ch * MAX_WIDTH) / cw); cw = MAX_WIDTH; }
  if (cw < MIN_WIDTH) { ch = Math.round((ch * MIN_WIDTH) / cw); cw = MIN_WIDTH; }
  return { width: cw, height: Math.max(1, ch) };
}

async function forInstagram(buf) {
  const s = lib();
  if (!s) {
    // sharp missing: send the original and let Instagram decide (works if it is already a JPEG)
    log('sharp is not installed - sending the image to Instagram without converting it');
    return { buffer: buf, converted: false };
  }
  const img = s(buf).rotate();                 // rotate() honours the EXIF orientation
  const meta = await img.metadata();
  const box = canvas(meta.width || MIN_WIDTH, meta.height || MIN_WIDTH);

  for (const quality of [88, 80, 70, 60]) {
    const out = await s(buf)
      .rotate()
      .resize({
        width: box.width,
        height: box.height,
        fit: 'contain',                        // never crop
        background: { r: 255, g: 255, b: 255 },
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })   // PNG transparency -> white
      .jpeg({ quality, progressive: true, mozjpeg: true })
      .toBuffer();
    if (out.length <= MAX_BYTES) {
      return { buffer: out, converted: true, width: box.width, height: box.height, bytes: out.length };
    }
  }
  throw new Error('Image is too large for Instagram even after compressing');
}

module.exports = { forInstagram, canvas, available: () => !!lib() };
