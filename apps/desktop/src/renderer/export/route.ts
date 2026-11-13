/**
 * Which encoder writes an export, decided before it starts:
 *
 *   1. WebCodecs with a hardware H.264 encoder (+ AAC): the usual path, every platform.
 *   2. Windows only: the helper with Windows' own Media Foundation encoders (software H.264 +
 *      AAC), when the renderer has no hardware H.264 encoder. Electron's bundled software H.264
 *      encoder (OpenH264) is never used.
 *   3. Otherwise WebM (VP9 + Opus) instead of MP4, said plainly before and after the export.
 *
 * Pure functions only (no DOM, no IPC), so the decision and the pixel/sample conversions the
 * Media Foundation path needs are unit-tested on any machine.
 */
import type { ExportFormat } from '../../shared/distribution';

export type ExportRoute =
  | { kind: 'webcodecs' }
  | { kind: 'mf' }
  | { kind: 'webm-fallback'; reason: 'no-h264' | 'no-aac' | 'forced' }
  | { kind: 'unsupported'; reason: 'no-h264' | 'no-aac' };

export interface RouteFacts {
  format: ExportFormat;
  platform: string;
  includeAudio: boolean;
  /** WebCodecs offers a hardware H.264 encoder for this size and frame rate. */
  hardwareH264: boolean;
  /** WebCodecs offers an AAC encoder. */
  webCodecsAac: boolean;
  /** The Windows helper wrote a test MP4 with Media Foundation (export:encoderInfo). */
  mfAvailable: boolean;
  /** This distribution offers WebM, so it can stand in for MP4. */
  webmOffered: boolean;
  /** Test runs only (ZEYVOLA_TEST_EXPORT_ROUTE). */
  forced?: 'mf' | 'webm';
}

export function chooseRoute(f: RouteFacts): ExportRoute {
  if (f.format !== 'mp4') return { kind: 'webcodecs' };
  const mf = f.platform === 'win32' && f.mfAvailable;
  if (f.forced === 'webm') return f.webmOffered ? { kind: 'webm-fallback', reason: 'forced' } : { kind: 'unsupported', reason: 'no-h264' };
  if (f.forced === 'mf' && mf) return { kind: 'mf' };
  if (f.hardwareH264 && (!f.includeAudio || f.webCodecsAac)) return { kind: 'webcodecs' };
  if (mf) return { kind: 'mf' };
  const reason = f.hardwareH264 ? 'no-aac' : 'no-h264';
  return f.webmOffered ? { kind: 'webm-fallback', reason } : { kind: 'unsupported', reason };
}

/** The format actually written: WebM when the route stands in for MP4. */
export function writtenFormat(format: ExportFormat, route: ExportRoute): ExportFormat {
  return route.kind === 'webm-fallback' ? 'webm' : format;
}

// ─── RGBA → NV12 (BT.709, limited range) ───────────────────────────────────────

// Y' = 16 + 219·(0.2126 R + 0.7152 G + 0.0722 B)/255; Cb/Cr = 128 + 224·(…)/255 (ITU-R BT.709),
// in 16.16 fixed point. Chroma is the average of each 2×2 block.
const S = 65536;
const KY = [0.2126, 0.7152, 0.0722].map((k) => Math.round((219 / 255) * k * S));
const KU = [-0.2126 / 1.8556, -0.7152 / 1.8556, 0.5].map((k) => Math.round((224 / 255) * k * S));
const KV = [0.5, -0.7152 / 1.5748, -0.0722 / 1.5748].map((k) => Math.round((224 / 255) * k * S));
const [YR, YG, YB] = KY as [number, number, number];
const [UR, UG, UB] = KU as [number, number, number];
const [VR, VG, VB] = KV as [number, number, number];

export function nv12Size(width: number, height: number): number {
  return width * height + (width * height) / 2;
}

/** `width` and `height` must be even. Writes into `out` when given (reused between frames). */
export function rgbaToNv12(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, out = new Uint8Array(nv12Size(width, height))): Uint8Array {
  const half = S / 2;
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    let o = y * width;
    for (let x = 0; x < width; x++, i += 4) {
      out[o++] = (16 * S + YR * rgba[i]! + YG * rgba[i + 1]! + YB * rgba[i + 2]! + half) >> 16;
    }
  }
  let o = width * height;
  for (let y = 0; y < height; y += 2) {
    const r0 = y * width * 4;
    const r1 = r0 + width * 4;
    for (let x = 0; x < width; x += 2) {
      const a = r0 + x * 4;
      const b = r1 + x * 4;
      const r = rgba[a]! + rgba[a + 4]! + rgba[b]! + rgba[b + 4]!;
      const g = rgba[a + 1]! + rgba[a + 5]! + rgba[b + 1]! + rgba[b + 5]!;
      const bl = rgba[a + 2]! + rgba[a + 6]! + rgba[b + 2]! + rgba[b + 6]!;
      // Sums of four pixels: divide by 4 inside the shift.
      out[o++] = Math.min(255, Math.max(0, (128 * 4 * S + UR * r + UG * g + UB * bl + 2 * S) >> 18));
      out[o++] = Math.min(255, Math.max(0, (128 * 4 * S + VR * r + VG * g + VB * bl + 2 * S) >> 18));
    }
  }
  return out;
}

// ─── PCM ──────────────────────────────────────────────────────────────────────

/** Stereo float samples [-1, 1] → 16-bit little-endian interleaved PCM (what Windows' AAC encoder takes). */
export function toPcm16Stereo(left: Float32Array, right: Float32Array, from: number, count: number): Uint8Array {
  const out = new Uint8Array(count * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    const l = Math.max(-1, Math.min(1, left[from + i] ?? 0));
    const r = Math.max(-1, Math.min(1, right[from + i] ?? 0));
    view.setInt16(i * 4, Math.round(l * 32767), true);
    view.setInt16(i * 4 + 2, Math.round(r * 32767), true);
  }
  return out;
}

/** Media Foundation times are in 100 ns units. */
export const HNS = 10_000_000;
