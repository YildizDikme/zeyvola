import { describe, expect, it } from 'vitest';
import { GifWriter, lzwEncode, medianCutPalette, PaletteMapper, TRANSPARENT, type Rgb } from './gif';

/** LZW decoder written separately from the encoder, following GIF89a Appendix F. */
function lzwDecode(data: Uint8Array, minCodeSize: number, count: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let dict: number[][] = [];
  let width = minCodeSize + 1;
  let prev: number[] | null = null;
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
    width = minCodeSize + 1;
    prev = null;
  };
  resetDict();
  let pos = 0;
  let acc = 0;
  let nbits = 0;
  for (;;) {
    while (nbits < width) {
      if (pos >= data.length) throw new Error('data ended before end-of-information');
      acc |= data[pos++]! << nbits;
      nbits += 8;
    }
    const code = acc & ((1 << width) - 1);
    acc >>>= width;
    nbits -= width;
    if (code === clear) { resetDict(); continue; }
    if (code === eoi) break;
    let entry: number[];
    if (prev === null) {
      entry = dict[code]!;
    } else {
      if (code < dict.length) entry = dict[code]!;
      else if (code === dict.length) entry = [...prev, prev[0]!];
      else throw new Error(`bad code ${code}`);
      if (dict.length < 4096) dict.push([...prev, entry[0]!]);
      if (dict.length === 1 << width && width < 12) width++;
    }
    out.push(...entry);
    prev = entry;
  }
  expect(out.length).toBe(count);
  return Uint8Array.from(out);
}

interface Decoded { width: number; height: number; palette: Rgb[]; loop: number | null; frames: { delay: number; pixels: Uint8Array; rect: number[] }[]; extensions: number[] }

/** Reads a GIF made by GifWriter back into full frames of palette indices. */
function decodeGif(b: Uint8Array): Decoded {
  let p = 0;
  const u8 = () => b[p++]!;
  const u16 = () => { const v = b[p]! | (b[p + 1]! << 8); p += 2; return v; };
  const ascii = (n: number) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const blocks = () => { const parts: number[] = []; for (let n = u8(); n > 0; n = u8()) for (let i = 0; i < n; i++) parts.push(u8()); return Uint8Array.from(parts); };
  expect(ascii(6)).toBe('GIF89a');
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); u8();
  expect(packed & 0x80).toBe(0x80);
  const size = 2 << (packed & 7);
  const palette: Rgb[] = [];
  for (let i = 0; i < size; i++) palette.push([u8(), u8(), u8()]);
  const screen = new Uint8Array(width * height);
  const frames: Decoded['frames'] = [];
  const extensions: number[] = [];
  let loop: number | null = null;
  let delay = 0;
  let transparent: number | null = null;
  for (;;) {
    const kind = u8();
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = u8();
      extensions.push(label);
      if (label === 0xf9) {
        expect(u8()).toBe(4);
        const flags = u8();
        delay = u16();
        const t = u8();
        transparent = flags & 1 ? t : null;
        expect(u8()).toBe(0);
      } else if (label === 0xff) {
        expect(u8()).toBe(11);
        const id = ascii(11);
        const data = blocks();
        if (id === 'NETSCAPE2.0' && data[0] === 1) loop = data[1]! | (data[2]! << 8);
      } else {
        blocks();
      }
      continue;
    }
    expect(kind).toBe(0x2c);
    const x = u16(); const y = u16(); const w = u16(); const h = u16();
    expect(u8() & 0x80).toBe(0); // no local colour table
    const min = u8();
    const idx = lzwDecode(blocks(), min, w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const v = idx[r * w + c]!;
        if (v !== transparent) screen[(y + r) * width + x + c] = v;
      }
    }
    frames.push({ delay, pixels: screen.slice(), rect: [x, y, w, h] });
  }
  expect(p).toBe(b.length);
  return { width, height, palette, loop, frames, extensions };
}

const rgba = (w: number, h: number, at: (x: number, y: number) => Rgb): Uint8Array => {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { out.set([...at(x, y), 255], (y * w + x) * 4); }
  return out;
};

describe('lzwEncode', () => {
  it('codes a known 2-bit picture byte for byte', () => {
    // Indices 0 0 1 1, minimum code size 2: clear(4) 0 0 1 in 3 bits, adding entries 6, 7, 8;
    // the decoder, one entry behind, widens to 4 bits once it holds 8 entries, so the last
    // 1 and end-of-information(5) are 4 bits wide. Packed least significant bit first.
    const codes: [number, number][] = [[4, 3], [0, 3], [0, 3], [1, 3], [1, 4], [5, 4]];
    let acc = 0; let n = 0; const want: number[] = [];
    for (const [c, bits] of codes) { acc |= c << n; n += bits; while (n >= 8) { want.push(acc & 255); acc >>= 8; n -= 8; } }
    if (n) want.push(acc & 255);
    expect(want).toEqual([0x04, 0x12, 0x05]);
    expect([...lzwEncode(Uint8Array.from([0, 0, 1, 1]), 2)]).toEqual(want);
  });

  it('round-trips through an independent decoder, across code widths and table clears', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const [n, colours, min] of [[1, 4, 2], [500, 4, 2], [20_000, 16, 4], [120_000, 256, 8], [60_000, 3, 8]] as const) {
      const input = new Uint8Array(n);
      // Runs and noise, so both long matches and a full 4096-entry table occur.
      for (let i = 0; i < n; i++) input[i] = rnd() < 0.3 ? Math.floor(rnd() * colours) : (input[i - 1] ?? 0);
      expect(lzwDecode(lzwEncode(input, min), min, n)).toEqual(input);
    }
  });
});

describe('medianCutPalette / PaletteMapper', () => {
  it('keeps a few distinct colours exactly', () => {
    const colours: Rgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [250, 250, 250]];
    const frame = rgba(8, 8, (x, y) => colours[(x + y) % 4]!);
    const pal = medianCutPalette([frame], 255, 1);
    expect(pal.length).toBe(4);
    for (const c of colours) expect(pal).toContainEqual(c);
    const m = new PaletteMapper(pal);
    expect(pal[m.index(255, 0, 0)]).toEqual([255, 0, 0]);
  });

  it('never gives more than 255 colours, so index 255 stays free for transparency', () => {
    const frame = rgba(64, 64, (x, y) => [x * 4, y * 4, (x * y) & 255]);
    expect(medianCutPalette([frame], 255, 1).length).toBeLessThanOrEqual(255);
  });
});

describe('GifWriter', () => {
  it('writes a looping GIF89a whose frames read back to the input', () => {
    const w = 23;
    const h = 11;
    const pal: Rgb[] = [[0, 0, 0], [255, 255, 255], [200, 30, 30]];
    const a = rgba(w, h, (x) => (x < 10 ? pal[0]! : pal[1]!));
    const b = rgba(w, h, (x, y) => (x >= 4 && x < 7 && y >= 2 && y < 5 ? pal[2]! : x < 10 ? pal[0]! : pal[1]!));
    const gif = new GifWriter({ width: w, height: h, palette: pal });
    gif.addFrame(a, 10);
    gif.addFrame(b, 25);
    gif.addFrame(b, 5); // unchanged frame
    const bytes = gif.finish();
    const d = decodeGif(bytes);
    expect([d.width, d.height, d.loop]).toEqual([w, h, 0]);
    expect(d.palette.slice(0, 3)).toEqual(pal);
    expect(d.frames.map((f) => f.delay)).toEqual([10, 25, 5]);
    const want = (src: Uint8Array) => new PaletteMapper(pal).map(src);
    expect(d.frames[0]!.pixels).toEqual(want(a));
    expect(d.frames[1]!.pixels).toEqual(want(b));
    expect(d.frames[2]!.pixels).toEqual(want(b));
    // Only the graphic control and looping blocks: no comment, text or other metadata.
    expect(new Set(d.extensions)).toEqual(new Set([0xff, 0xf9]));
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it('stores only the changed rectangle of a later frame', () => {
    const w = 200;
    const h = 100;
    const pal: Rgb[] = [[10, 10, 10], [240, 240, 240]];
    const gif = new GifWriter({ width: w, height: h, palette: pal });
    gif.addFrame(rgba(w, h, () => pal[0]!), 10);
    gif.addFrame(rgba(w, h, (x, y) => (x === 150 && y === 60 ? pal[1]! : pal[0]!)), 10);
    const bytes = gif.finish();
    const d = decodeGif(bytes);
    expect(d.frames[1]!.rect).toEqual([150, 60, 1, 1]);
    expect(d.frames[1]!.pixels[60 * w + 150]).toBe(1);
    expect(TRANSPARENT).toBe(255);
  });
});
