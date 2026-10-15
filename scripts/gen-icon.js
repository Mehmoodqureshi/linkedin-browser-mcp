#!/usr/bin/env node
/**
 * Dependency-free icon generator.
 *
 * The repo ships no binary art and the build box has no SVG rasterizer / PIL,
 * so we render an original project mark into an RGBA pixel buffer and encode a
 * PNG with Node's zlib. The white stepped M on a green square uses no external
 * images, fonts, or platform logos. It is covered by the project MIT license.
 *
 * Outputs:
 *   assets/icon.iconset/*.png  (fed to `iconutil` by the caller → icon.icns)
 *   assets/icon.png            (1024² — Linux + electron-builder base)
 *   assets/icon.ico            (256² PNG wrapped in an ICO container — Windows)
 *   resources/tray-icon.png    (32² — macOS/Win tray)
 *
 * Pure Node, no third-party modules.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// PNG encoding (8-bit RGBA, color type 6)
// ---------------------------------------------------------------------------

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
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA Uint8Array (size*size*4) into a PNG Buffer. */
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend each scanline with filter byte 0 (none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
/** Smooth 0→1 coverage across a ~1px edge for cheap anti-aliasing. */
function aa(dist) {
  return clamp01(0.5 - dist);
}

/**
 * Render the icon at `size` into an RGBA Uint8Array.
 *
 * Coordinates are normalized by `size` so the mark scales cleanly. The M
 * monogram is built from axis-aligned bars; corners of the background square
 * are rounded with a signed-distance test + 1px AA.
 */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  const N = size;

  // Background rounded square with an independent green palette.
  const radius = 0.225 * N;
  const TOP = [0x16, 0x6b, 0x56];
  const BOT = [0x0c, 0x37, 0x31];

  // Original stepped M monogram, drawn with bars instead of a font.
  const bars = [
    [0.24, 0.26, 0.35, 0.74],
    [0.65, 0.26, 0.76, 0.74],
    [0.35, 0.34, 0.45, 0.48],
    [0.55, 0.34, 0.65, 0.48],
    [0.45, 0.44, 0.55, 0.58],
  ].map(rect => rect.map(value => value * N));

  const inRect = (x, y, r) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

  // Distance outside a rounded rect [0,N]² with corner `radius` (negative inside).
  function roundedRectDist(x, y) {
    const r = radius;
    // Distance from the inner core rectangle, expanded by r.
    const dx = Math.max(r - x, x - (N - r), 0);
    const dy = Math.max(r - y, y - (N - r), 0);
    // In a corner region both dx,dy > 0 → euclidean; else along an edge.
    if (dx > 0 && dy > 0) return Math.hypot(dx, dy) - r;
    return Math.max(x < r || x > N - r ? -Math.min(x, N - x) : -N, 0) - 0; // unused branch guard
  }

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px0 = x + 0.5;
      const py0 = y + 0.5;

      // Background alpha via rounded-corner SDF.
      let bgA;
      const r = radius;
      const dx = Math.max(r - px0, px0 - (N - r), 0);
      const dy = Math.max(r - py0, py0 - (N - r), 0);
      if (dx > 0 && dy > 0) {
        bgA = aa(Math.hypot(dx, dy) - r);
      } else {
        bgA = 1; // straight edges reach the bitmap border
      }

      const t = py0 / N;
      let r8 = Math.round(lerp(TOP[0], BOT[0], t));
      let g8 = Math.round(lerp(TOP[1], BOT[1], t));
      let b8 = Math.round(lerp(TOP[2], BOT[2], t));
      let a8 = Math.round(bgA * 255);

      // Composite the white monogram on top.
      let mark = 0;
      for (const rect of bars) {
        if (inRect(px0, py0, rect)) {
          mark = 1;
          break;
        }
      }
      if (mark && bgA > 0) {
        r8 = 0xff;
        g8 = 0xff;
        b8 = 0xff;
      }

      const o = (y * N + x) * 4;
      px[o] = r8;
      px[o + 1] = g8;
      px[o + 2] = b8;
      px[o + 3] = a8;
    }
  }
  // silence unused helper without changing behavior
  void roundedRectDist;
  return px;
}

function writePNG(file, size) {
  const buf = encodePNG(render(size), size);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// ICO container (single 256² PNG entry; valid since Windows Vista)
// ---------------------------------------------------------------------------

function writeICO(file, pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 encoded as 0
  entry[1] = 0; // height 256 encoded as 0
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8); // size of PNG
  entry.writeUInt32LE(6 + 16, 12); // offset
  fs.writeFileSync(file, Buffer.concat([header, entry, pngBuf]));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const iconset = path.join(ROOT, 'assets', 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });

// macOS .iconset members (name → pixel size).
const iconsetSizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [name, sz] of iconsetSizes) writePNG(path.join(iconset, name), sz);

const png1024 = writePNG(path.join(ROOT, 'assets', 'icon.png'), 1024);
void png1024;
const png256 = encodePNG(render(256), 256);
writeICO(path.join(ROOT, 'assets', 'icon.ico'), png256);
writePNG(path.join(ROOT, 'resources', 'tray-icon.png'), 32);

// macOS: compile the .iconset into the .icns electron-builder expects. iconutil
// is macOS-only, so skip it elsewhere — the .png/.ico cover Linux/Windows.
if (process.platform === 'darwin') {
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(ROOT, 'assets', 'icon.icns')], {
      stdio: 'inherit',
    });
  } catch (err) {
    process.stderr.write(`[gen-icon] iconutil failed: ${err.message}\n`);
    process.exit(1);
  }
}

process.stdout.write(
  'icons generated: assets/icon.icns, assets/icon.png, assets/icon.ico, resources/tray-icon.png\n',
);
