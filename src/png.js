// Minimal dependency-free PNG writer (RGB, 8-bit) + a tiny raster canvas, used
// to draw speech "pictures" the coding agent can look at.

import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export class Canvas {
  constructor(width, height, bg = [255, 255, 255]) {
    this.w = width;
    this.h = height;
    this.px = Buffer.alloc(width * height * 3);
    this.fill(0, 0, width, height, bg);
  }
  set(x, y, [r, g, b]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
  }
  fill(x0, y0, x1, y1, color) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) this.set(x, y, color);
    }
  }
  vline(x, y0, y1, color) {
    for (let y = Math.floor(Math.min(y0, y1)); y <= Math.ceil(Math.max(y0, y1)); y++) this.set(x, y, color);
  }
  hline(x0, x1, y, color) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) this.set(x, y, color);
  }
  dot(x, y, color, r = 1) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.set(x + dx, y + dy, color);
  }
  toPng() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0; // filter: none
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}
