// gen-icons.mjs — 生成扩展所需的 16/48/128 PNG 图标（纯 Node，无第三方依赖）。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(outDir, { recursive: true });

/* ---------- 最小 PNG 编码器 ---------- */
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
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 图标绘制（4x 超采样抗锯齿） ---------- */
function roundRectInside(x, y, size, r) {
  let dx = 0;
  let dy = 0;
  if (x < r) dx = r - x;
  else if (x > size - r) dx = x - (size - r);
  if (y < r) dy = r - y;
  else if (y > size - r) dy = y - (size - r);
  return Math.hypot(dx, dy) <= r;
}

// 返回某点的 RGBA（相机镜头风格：蓝色圆角底 + 白色镜环 + 浅蓝内圆）
function sample(x, y, size) {
  if (!roundRectInside(x, y, size, size * 0.22)) return [0, 0, 0, 0];
  const cx = size / 2;
  const cy = size / 2;
  const d = Math.hypot(x - cx, y - cy);
  const lensR = size * 0.3;
  const ringW = size * 0.082;
  if (d > lensR) return [37, 99, 235, 255]; // #2563eb 底色
  if (d > lensR - ringW) return [255, 255, 255, 255]; // 白色镜环
  if (d > lensR - ringW - size * 0.03) return [37, 99, 235, 255];
  return [147, 197, 253, 255]; // #93c5fd 内圆
}

function makeIcon(size) {
  const ss = 4; // 超采样倍数
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let oy = 0; oy < ss; oy++) {
        for (let ox = 0; ox < ss; ox++) {
          const px = x + (ox + 0.5) / ss;
          const py = y + (oy + 0.5) / ss;
          const [r, g, b, a] = sample(px, py, size);
          // 预乘 alpha，避免边缘出现暗边
          sr += r * a;
          sg += g * a;
          sb += b * a;
          sa += a;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      rgba[i + 3] = Math.round(sa / n);
      if (sa > 0) {
        rgba[i] = Math.round(sr / sa);
        rgba[i + 1] = Math.round(sg / sa);
        rgba[i + 2] = Math.round(sb / sa);
      }
    }
  }
  return encodePNG(size, rgba);
}

for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  writeFileSync(file, makeIcon(size));
  console.log('生成图标', file);
}
