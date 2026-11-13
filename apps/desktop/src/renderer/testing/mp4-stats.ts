/**
 * What an MP4 file says about itself, read from its boxes (ISO/IEC 14496-12, -15): per track the
 * handler, sample entry, duration and the bytes of its samples (so the real bit rate), and for H.264
 * the profile and level from avcC. Used by the interface test to judge an export by the file, not by
 * what an encoder was asked for. No decoding.
 */
export interface Mp4Track {
  handler: string;
  codec: string;
  seconds: number;
  sampleBytes: number;
  samples: number;
  kbps: number;
  /** H.264: profile_idc (66 Baseline, 77 Main, 100 High) and level_idc (40 = 4.0). */
  avcProfile?: number;
  avcLevel?: number;
}

const PROFILE_NAMES: Record<number, string> = { 66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10', 122: 'High 4:2:2', 244: 'High 4:4:4' };
export const avcProfileName = (p: number | undefined): string => (p === undefined ? '?' : PROFILE_NAMES[p] ?? `profil ${p}`);

interface Box { type: string; start: number; end: number; body: number }

function boxes(d: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = d.getUint32(p);
    const type = String.fromCharCode(d.getUint8(p + 4), d.getUint8(p + 5), d.getUint8(p + 6), d.getUint8(p + 7));
    let body = p + 8;
    if (size === 1) { size = Number(d.getBigUint64(p + 8)); body = p + 16; } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}
const child = (d: DataView, b: Box, type: string, skip = 0): Box | undefined => boxes(d, b.body + skip, b.end).find((x) => x.type === type);
const path = (d: DataView, b: Box | undefined, ...types: string[]): Box | undefined => types.reduce<Box | undefined>((x, t) => (x ? child(d, x, t) : undefined), b);

export function mp4Tracks(file: Uint8Array): Mp4Track[] {
  const d = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const moov = boxes(d, 0, file.byteLength).find((b) => b.type === 'moov');
  if (!moov) return [];
  return boxes(d, moov.body, moov.end).filter((b) => b.type === 'trak').map((trak) => {
    const mdia = child(d, trak, 'mdia');
    const mdhd = path(d, mdia, 'mdhd');
    const hdlr = path(d, mdia, 'hdlr');
    const stbl = path(d, mdia, 'minf', 'stbl');
    let seconds = 0;
    if (mdhd) {
      const v1 = d.getUint8(mdhd.body) === 1;
      const timescale = d.getUint32(mdhd.body + (v1 ? 20 : 12));
      const duration = v1 ? Number(d.getBigUint64(mdhd.body + 24)) : d.getUint32(mdhd.body + 16);
      seconds = timescale ? duration / timescale : 0;
    }
    const handler = hdlr ? String.fromCharCode(...[0, 1, 2, 3].map((i) => d.getUint8(hdlr.body + 8 + i))) : '?';
    // stsd: full box (4) + entry count (4), then the sample entries.
    const stsd = stbl ? child(d, stbl, 'stsd') : undefined;
    const entry = stsd ? boxes(d, stsd.body + 8, stsd.end)[0] : undefined;
    const codec = entry?.type ?? '?';
    let avcProfile: number | undefined;
    let avcLevel: number | undefined;
    if (entry && (codec === 'avc1' || codec === 'avc3')) {
      // VisualSampleEntry: 8 (SampleEntry) + 70 bytes before its child boxes.
      const avcC = boxes(d, entry.body + 78, entry.end).find((b) => b.type === 'avcC');
      if (avcC) { avcProfile = d.getUint8(avcC.body + 1); avcLevel = d.getUint8(avcC.body + 3); }
    }
    let sampleBytes = 0;
    let samples = 0;
    const stsz = stbl ? child(d, stbl, 'stsz') : undefined;
    if (stsz) {
      const fixed = d.getUint32(stsz.body + 4);
      samples = d.getUint32(stsz.body + 8);
      if (fixed) sampleBytes = fixed * samples;
      else for (let i = 0; i < samples; i++) sampleBytes += d.getUint32(stsz.body + 12 + i * 4);
    }
    return { handler, codec, seconds, sampleBytes, samples, kbps: seconds ? (sampleBytes * 8) / seconds / 1000 : 0, avcProfile, avcLevel };
  });
}

// ─── Comparing a decoded frame with the picture it should show ────────────────

/** Luma of RGBA pixels (BT.709 weights), 0…255. */
function luma(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = 0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!;
  return out;
}

/** Mean absolute Laplacian of the luma: how much fine detail (edges of text) a picture keeps. */
export function sharpness(rgba: Uint8ClampedArray, w: number, h: number): number {
  const y = luma(rgba);
  let sum = 0;
  let n = 0;
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      sum += Math.abs(4 * y[i]! - y[i - 1]! - y[i + 1]! - y[i - w]! - y[i + w]!);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** PSNR of the RGB channels (dB) and the mean difference per channel (decoded − reference). */
export function compareFrames(a: Uint8ClampedArray, b: Uint8ClampedArray): { psnr: number; meanDiff: [number, number, number] } {
  let se = 0;
  const diff: [number, number, number] = [0, 0, 0];
  const n = Math.min(a.length, b.length) / 4;
  for (let i = 0; i < n * 4; i += 4) {
    for (let c = 0; c < 3; c++) {
      const e = a[i + c]! - b[i + c]!;
      se += e * e;
      diff[c] = diff[c]! + e;
    }
  }
  const mse = se / (n * 3);
  return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), meanDiff: diff.map((x) => x / n) as [number, number, number] };
}
