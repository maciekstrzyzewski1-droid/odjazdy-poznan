#!/usr/bin/env node
// Generuje ikony PNG (bez zależności): przód tramwaju w bursztynie na ciemnym tle.
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [13, 15, 17], AMBER = [255, 182, 39];
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += c[0]; g += c[1]; b += c[2]; a += c[3] ?? 255;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r / 16; raw[o + 1] = g / 16; raw[o + 2] = b / 16; raw[o + 3] = a / 16;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const rrect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const circ = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// s = skala rysunku (maskowalna ikona potrzebuje marginesu ~20%)
function tram(s, rounded) {
  return (u, v) => {
    const x = 0.5 + (u - 0.5) / s, y = 0.5 + (v - 0.5) / s;
    if (rounded && !rrect(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0];
    // pantograf
    if ((Math.abs(x - 0.5) < 0.018 && y > 0.1 && y < 0.2) || (Math.abs(y - 0.1) < 0.018 && x > 0.38 && x < 0.62)) return AMBER;
    if (rrect(x, y, 0.24, 0.19, 0.76, 0.8, 0.09)) {
      if (rrect(x, y, 0.31, 0.27, 0.69, 0.5, 0.04)) return BG;          // szyba
      if (circ(x, y, 0.37, 0.64, 0.045) || circ(x, y, 0.63, 0.64, 0.045)) return BG; // reflektory
      if (Math.abs(y - 0.555) < 0.014 && x > 0.31 && x < 0.69) return BG;  // listwa
      return AMBER;
    }
    // szyny
    if (Math.abs(y - 0.87) < 0.016 && x > 0.18 && x < 0.82) return AMBER;
    return BG;
  };
}

const out = 'app/icons';
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/icon-192.png`, png(192, tram(0.86, true)));
fs.writeFileSync(`${out}/icon-512.png`, png(512, tram(0.86, true)));
fs.writeFileSync(`${out}/icon-maskable-512.png`, png(512, tram(0.62, false)));
fs.writeFileSync(`${out}/apple-touch-icon.png`, png(180, tram(0.8, false)));
fs.writeFileSync(`${out}/icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="#0d0f11"/>
<g transform="translate(50 50) scale(.86) translate(-50 -50)" fill="#ffb627">
<rect x="48.2" y="10" width="3.6" height="10"/><rect x="38" y="8.2" width="24" height="3.6"/>
<rect x="24" y="19" width="52" height="61" rx="9"/><rect x="18" y="85.4" width="64" height="3.2"/>
<g fill="#0d0f11"><rect x="31" y="27" width="38" height="23" rx="4"/><circle cx="37" cy="64" r="4.5"/><circle cx="63" cy="64" r="4.5"/><rect x="31" y="54.1" width="38" height="2.8"/></g>
</g></svg>
`);
console.log('Ikony zapisane w', out);
