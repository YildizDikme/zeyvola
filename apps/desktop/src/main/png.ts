import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Minimal RGBA PNG encoder, used for generated tray icons (no image assets shipped). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Anti-aliased filled circle; `ring` draws an outline instead. */
export function circleIcon(size: number, rgb: [number, number, number], ring = false): Buffer {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = size * 0.36;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = ring
        ? Math.max(0, Math.min(1, 1.2 - Math.abs(d - r) / (size * 0.06)))
        : Math.max(0, Math.min(1, r - d + 0.5));
      const i = (y * size + x) * 4;
      px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, px);
}

function roundBoxSdf(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Zeyvola's app icon, drawn procedurally (no image asset): a graphite tile with the stage
 * outline and the tungsten camera bubble from the brand mark.
 */
export function appIcon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const tile = size * 0.82; // leaves the platform's usual transparent margin
  const t0 = (size - tile) / 2;
  const tileR = tile * 0.225;
  // Brand mark is designed on a 24-unit grid; place it inside the tile.
  const unit = (tile * 0.62) / 24;
  const ox = t0 + (tile - 24 * unit) / 2;
  const oy = t0 + (tile - 24 * unit) / 2 + unit * 0.4;
  const cov = (d: number) => Math.max(0, Math.min(1, 0.5 - d));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      const dTile = roundBoxSdf(sx, sy, size / 2, size / 2, tile / 2, tile / 2, tileR);
      const aTile = cov(dTile);
      if (aTile <= 0) continue;
      // Tile: vertical graphite gradient with a faint top sheen.
      const v = (sy - t0) / tile;
      let r = 34 - 20 * v;
      let g = 34 - 20 * v;
      let b = 37 - 22 * v;
      const sheen = Math.max(0, 1 - v * 3) * 10;
      r += sheen; g += sheen; b += sheen;
      // Design-space coordinates.
      const u = (sx - ox) / unit;
      const w = (sy - oy) / unit;
      // Stage outline (rect 2.5,4 → 21.5,17.5, radius 3.5, stroke 1.7).
      const dStage = Math.abs(roundBoxSdf(u, w, 12, 10.75, 9.5, 6.75, 3.5)) - 0.85;
      const aStage = cov(dStage * unit);
      r += (245 - r) * aStage; g += (245 - g) * aStage; b += (247 - b) * aStage;
      // Ring in tile colour separates the bubble from the outline, then the bubble.
      const dc = Math.hypot(u - 17.3, w - 16.6);
      const aRing = cov((dc - 5.2) * unit);
      r += (24 - r) * aRing; g += (24 - g) * aRing; b += (26 - b) * aRing;
      const aDot = cov((dc - 4.4) * unit);
      r += (255 - r) * aDot; g += (148 - g) * aDot; b += (12 - b) * aDot;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = Math.round(aTile * 255);
    }
  }
  return encodePng(size, size, px);
}
