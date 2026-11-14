/**
 * A small animated GIF writer for the README demo (`pnpm docshots`), written from the GIF89a
 * specification (W3C, "Graphics Interchange Format, Version 89a", 1990): header, logical
 * screen descriptor, global colour table, graphic control extension, image descriptor, LZW
 * table based image data (Appendix F) and trailer. No dependencies; no DOM, so it is unit
 * tested in Node.
 *
 * Choices kept simple on purpose:
 *   - one global palette of up to 255 colours from a median cut over all frames, no dithering;
 *     index 255 is the transparent colour of later frames;
 *   - each later frame stores only the rectangle that changed since the previous one, with
 *     unchanged pixels transparent ("do not dispose"), so still stretches cost a few bytes;
 *   - the looping block is the widely read "NETSCAPE2.0" application extension, which the
 *     GIF89a text does not define; it uses the specification's application extension layout.
 * The output carries no comment, text or other metadata blocks.
 */

export type Rgb = [number, number, number];

/** Index of the transparent colour in every palette this writer makes. */
export const TRANSPARENT = 255;

// ─── Palette ──────────────────────────────────────────────────────────────────

interface Box { pixels: Int32Array; lo: number; hi: number }

/**
 * Median cut: splits the colour cube of the sampled pixels, always cutting the box with the
 * widest channel range at its median, until there are `max` boxes; each box's average colour
 * becomes one palette entry. `frames` are RGBA bytes; every `step`-th pixel is sampled.
 */
export function medianCutPalette(frames: readonly Uint8ClampedArray[] | readonly Uint8Array[], max = 255, step = 7): Rgb[] {
  const samples: number[] = [];
  for (const f of frames) for (let i = 0; i < f.length; i += 4 * step) samples.push((f[i]! << 16) | (f[i + 1]! << 8) | f[i + 2]!);
  if (samples.length === 0) return [[0, 0, 0]];
  const pixels = Int32Array.from(samples);
  const range = (b: Box): [number, number] => {
    let best = 0;
    let channel = 0;
    for (let c = 0; c < 3; c++) {
      const shift = 16 - c * 8;
      let lo = 255;
      let hi = 0;
      for (let i = b.lo; i < b.hi; i++) { const v = (b.pixels[i]! >> shift) & 255; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi - lo > best) { best = hi - lo; channel = c; }
    }
    return [best, channel];
  };
  const boxes: Box[] = [{ pixels, lo: 0, hi: pixels.length }];
  while (boxes.length < max) {
    let pick = -1;
    let pickRange = 0;
    let pickChannel = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      if (b.hi - b.lo < 2) continue;
      const [r, c] = range(b);
      if (r > pickRange) { pickRange = r; pick = i; pickChannel = c; }
    }
    if (pick < 0) break; // every box holds one colour
    const b = boxes[pick]!;
    const shift = 16 - pickChannel * 8;
    const part = b.pixels.subarray(b.lo, b.hi).sort((x, y) => ((x >> shift) & 255) - ((y >> shift) & 255));
    let mid = b.lo + (part.length >> 1);
    // Keep equal values together so the two halves really differ.
    const midV = (b.pixels[mid]! >> shift) & 255;
    while (mid > b.lo + 1 && ((b.pixels[mid - 1]! >> shift) & 255) === midV) mid--;
    boxes.splice(pick, 1, { pixels, lo: b.lo, hi: mid }, { pixels, lo: mid, hi: b.hi });
  }
  return boxes.map((b) => {
    let r = 0; let g = 0; let bl = 0;
    for (let i = b.lo; i < b.hi; i++) { const v = b.pixels[i]!; r += (v >> 16) & 255; g += (v >> 8) & 255; bl += v & 255; }
    const n = b.hi - b.lo;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] as Rgb;
  });
}

/** Maps RGBA pixels to palette indices (nearest colour, remembered per 6-bit-per-channel cell). */
export class PaletteMapper {
  private readonly cache = new Int16Array(1 << 18).fill(-1);
  constructor(readonly palette: readonly Rgb[]) {
    if (palette.length < 1 || palette.length > 255) throw new Error('palette must hold 1…255 colours');
  }

  index(r: number, g: number, b: number): number {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = this.cache[key]!;
    if (hit >= 0) return hit;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.palette.length; i++) {
      const p = this.palette[i]!;
      const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.cache[key] = best;
    return best;
  }

  map(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
    const out = new Uint8Array(rgba.length >> 2);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = this.index(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    return out;
  }
}

// ─── LZW (Appendix F) ─────────────────────────────────────────────────────────

/**
 * LZW-compresses colour indices into the variable-length code stream of GIF image data
 * (without the sub-block framing). Starts with a clear code, ends with end-of-information,
 * and clears again whenever the 4096-entry table is full (no deferred clear).
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) throw new Error('minimum code size must be 2…8');
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  let width = minCodeSize + 1;
  let next = clear + 2;
  const emit = (code: number) => {
    acc |= code << nbits;
    nbits += width;
    while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; }
  };
  // Table of (prefix code, next index) → code. A generation number per slot makes a clear O(1).
  const codes = new Int16Array(4096 * 256);
  const gens = new Uint16Array(4096 * 256);
  let gen = 1;
  const reset = () => { gen++; width = minCodeSize + 1; next = clear + 2; };

  emit(clear);
  if (indices.length === 0) { emit(eoi); if (nbits > 0) out.push(acc & 255); return Uint8Array.from(out); }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    if (gens[key] === gen) { prefix = codes[key]!; continue; }
    emit(prefix);
    if (next < 4096) {
      codes[key] = next;
      gens[key] = gen;
      next++;
      // The decoder adds this entry one code later; it widens its codes when its next free
      // code reaches 2^width, which is when ours is one past that.
      if (next - 1 === 1 << width && width < 12) width++;
    }
    if (next === 4096) { emit(clear); reset(); }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (nbits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

// ─── Writer ───────────────────────────────────────────────────────────────────

class Bytes {
  private parts: Uint8Array[] = [];
  private cur: number[] = [];
  u8(v: number): this { this.cur.push(v & 255); return this; }
  u16(v: number): this { return this.u8(v).u8(v >> 8); }
  ascii(s: string): this { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  bytes(b: Uint8Array): this { this.flush(); this.parts.push(b); return this; }
  private flush(): void { if (this.cur.length) { this.parts.push(Uint8Array.from(this.cur)); this.cur = []; } }
  done(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

/** Splits data into sub-blocks of at most 255 bytes, ending with the zero-length terminator. */
function subBlocks(data: Uint8Array): Uint8Array {
  const n = Math.ceil(data.length / 255);
  const out = new Uint8Array(data.length + n + 1);
  let at = 0;
  for (let i = 0; i < data.length; i += 255) {
    const part = data.subarray(i, i + 255);
    out[at++] = part.length;
    out.set(part, at);
    at += part.length;
  }
  out[at] = 0;
  return out;
}

export interface GifOptions {
  width: number;
  height: number;
  /** Up to 255 colours; index 255 is kept for transparency. */
  palette: readonly Rgb[];
  /** Times to play; 0 = forever. */
  loop?: number;
}

/** Writes an animated GIF frame by frame. Frames are RGBA bytes of the full picture. */
export class GifWriter {
  private readonly out = new Bytes();
  private readonly mapper: PaletteMapper;
  private prev: Uint8Array | null = null;
  private frames = 0;

  constructor(private readonly o: GifOptions) {
    if (o.width < 1 || o.height < 1 || o.width > 65535 || o.height > 65535) throw new Error('size out of range');
    this.mapper = new PaletteMapper(o.palette);
    // Header and logical screen descriptor: global colour table of 256 entries (size field 7),
    // 8 bits per primary, background index 0, no aspect ratio information.
    this.out.ascii('GIF89a').u16(o.width).u16(o.height).u8(0x80 | (7 << 4) | 7).u8(0).u8(0);
    const table = new Uint8Array(256 * 3);
    o.palette.forEach((c, i) => table.set(c, i * 3));
    this.out.bytes(table);
    // Application extension "NETSCAPE2.0": sub-block 1 holds the loop count.
    this.out.u8(0x21).u8(0xff).u8(11).ascii('NETSCAPE2.0').u8(3).u8(1).u16(o.loop ?? 0).u8(0);
  }

  /** Adds one frame shown for `delayCs` hundredths of a second. */
  addFrame(rgba: Uint8ClampedArray | Uint8Array, delayCs: number): void {
    const { width: w, height: h } = this.o;
    if (rgba.length !== w * h * 4) throw new Error(`frame must be ${w}×${h} RGBA`);
    const idx = this.mapper.map(rgba);
    let x0 = 0; let y0 = 0; let x1 = w; let y1 = h;
    let data = idx;
    const prev = this.prev;
    if (prev) {
      // The rectangle that changed; everything else stays from the previous frame.
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (idx[row + x] !== prev[row + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } else { x1++; y1++; }
      if (x1 === 0) x1 = 1;
      if (y1 === 0) y1 = 1;
      const rw = x1 - x0;
      data = new Uint8Array(rw * (y1 - y0));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = idx[y * w + x]!;
          data[(y - y0) * rw + (x - x0)] = v === prev[y * w + x] ? TRANSPARENT : v;
        }
      }
    }
    // Graphic control extension: disposal 1 (do not dispose), transparency on later frames.
    this.out.u8(0x21).u8(0xf9).u8(4).u8((1 << 2) | (prev ? 1 : 0)).u16(Math.max(0, Math.round(delayCs))).u8(prev ? TRANSPARENT : 0).u8(0);
    // Image descriptor: no local colour table, not interlaced.
    this.out.u8(0x2c).u16(x0).u16(y0).u16(x1 - x0).u16(y1 - y0).u8(0);
    this.out.u8(8).bytes(subBlocks(lzwEncode(data, 8)));
    this.prev = idx;
    this.frames++;
  }

  get frameCount(): number { return this.frames; }

  /** Ends the stream with the trailer and returns the file. */
  finish(): Uint8Array {
    this.out.u8(0x3b);
    return this.out.done();
  }
}
