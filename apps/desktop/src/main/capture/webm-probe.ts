import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbedFile } from './helper-client';

/**
 * Playable length of a WebM file written by Chromium's MediaRecorder, including one cut off by a
 * crash (the browser recording path has no native helper to measure its files). MediaRecorder
 * writes a live stream: the Segment and each Cluster have an unknown size and there is no
 * duration or index. Matroska/EBML elements (ID, size, data) are walked: the start of the file
 * gives the time scale, the track and the first block; the end of the file, from its last
 * Cluster, gives the last complete block. Length = first to last block plus one typical block
 * duration. A block cut off at the end of the file is not counted. Only the head and the tail
 * are read, so a recording of several gigabytes is measured quickly.
 */

const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackType: 0x83, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5,
  Channels: 0x9f, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, Cues: 0x1c53bb6b,
} as const;
/** Elements that may hold others (needed to walk into unknown-size elements). */
const MASTER = new Set<number>([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.BlockGroup]);
/** Elements that close an unknown-size Cluster when they appear. */
const SEGMENT_LEVEL = new Set<number>([ID.Cluster, ID.Info, ID.Tracks, ID.Cues, 0x1254c367, 0x114d9b74, 0x1043a770, 0x1941a469]);
const HEAD = 512 * 1024;
const TAIL = 32 * 1024 * 1024;

interface Vint { value: number; length: number; unknown: boolean }

function readVint(b: Uint8Array, at: number, keepMarker: boolean): Vint | null {
  if (at >= b.length) return null;
  const first = b[at]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i]!;
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(b: Uint8Array, at: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[at + i]!;
  return v;
}

function readFloat(b: Uint8Array, at: number, size: number): number {
  const v = new DataView(b.buffer, b.byteOffset + at, size);
  return size === 4 ? v.getFloat32(0) : size === 8 ? v.getFloat64(0) : 0;
}

export interface WebmProbe {
  kind?: 'video' | 'audio';
  durationMs: number;
  firstMs: number;
  blocks: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

/** Walks EBML elements of one buffer and collects block times (ms) and track details. */
class Walker {
  clusterTime = 0;
  readonly times: number[] = [];
  readonly info: Omit<WebmProbe, 'durationMs' | 'firstMs' | 'blocks'> = {};

  constructor(public scale = 1_000_000) {}

  /** Walks [from, to); returns where it stopped. `to` is the parent's end (or the buffer end). */
  walk(b: Uint8Array, from: number, to: number, inCluster: boolean): number {
    let at = from;
    while (at < to) {
      const id = readVint(b, at, true);
      if (!id) return to;
      const size = readVint(b, at + id.length, false);
      if (!size) return to;
      const start = at + id.length + size.length;
      // An unknown-size Cluster ends where the next segment-level element begins.
      if (inCluster && SEGMENT_LEVEL.has(id.value)) return at;
      if (size.unknown) {
        if (!MASTER.has(id.value)) return to;
        at = this.walk(b, start, to, id.value === ID.Cluster || inCluster);
        continue;
      }
      const end = start + size.value;
      if (end > b.length) {
        // Cut off by the end of the buffer: walk into a master element, drop anything else.
        if (MASTER.has(id.value)) this.walk(b, start, b.length, id.value === ID.Cluster || inCluster);
        return to;
      }
      this.element(b, id.value, start, size.value, end, inCluster);
      at = end;
    }
    return to;
  }

  private element(b: Uint8Array, id: number, start: number, size: number, end: number, inCluster: boolean): void {
    switch (id) {
      case ID.TimecodeScale: this.scale = readUint(b, start, size) || this.scale; break;
      case ID.Timecode: if (inCluster) this.clusterTime = readUint(b, start, size); break;
      case ID.TrackType: { const t = readUint(b, start, size); if (t === 1) this.info.kind = 'video'; else if (t === 2) this.info.kind = 'audio'; break; }
      case ID.PixelWidth: this.info.width = readUint(b, start, size); break;
      case ID.PixelHeight: this.info.height = readUint(b, start, size); break;
      case ID.SamplingFrequency: this.info.sampleRate = Math.round(readFloat(b, start, size)); break;
      case ID.Channels: this.info.channels = readUint(b, start, size); break;
      case ID.SimpleBlock:
      case ID.Block: {
        const track = readVint(b, start, false);
        if (!track || start + track.length + 2 > end) break;
        const rel = new DataView(b.buffer, b.byteOffset + start + track.length, 2).getInt16(0);
        this.times.push(((this.clusterTime + rel) * this.scale) / 1e6);
        break;
      }
      default:
        if (MASTER.has(id)) this.walk(b, start, end, id === ID.Cluster || inCluster);
    }
  }
}

/** Median spacing of the last blocks: the duration of one block. */
function blockStep(times: number[]): number {
  const sorted = [...times].sort((x, y) => x - y).slice(-200);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!).filter((g) => g > 0).sort((x, y) => x - y);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
}

function result(info: Walker['info'], times: number[], first: number, last: number, step: number): WebmProbe {
  return { ...info, durationMs: last - first + step, firstMs: first, blocks: times.length };
}

/** Measures a whole WebM file held in memory. Null when no complete block is found. */
export function probeWebmBytes(b: Uint8Array): WebmProbe | null {
  const w = new Walker();
  w.walk(b, 0, b.length, false);
  if (!w.times.length) return null;
  return result(w.info, w.times, Math.min(...w.times), Math.max(...w.times), blockStep(w.times));
}

/**
 * Block times from the last Clusters in `tail` (a Cluster starts with its Timecode): walks from
 * Cluster starts found backwards until at least 20 complete blocks are seen, so one block's
 * duration can be estimated, or no earlier Cluster is left.
 */
function lastClusterTimes(tail: Uint8Array, scale: number): number[] | null {
  let best: number[] | null = null;
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] !== 0x1f || tail[i + 1] !== 0x43 || tail[i + 2] !== 0xb6 || tail[i + 3] !== 0x75) continue;
    const size = readVint(tail, i + 4, false);
    if (!size) continue;
    const child = readVint(tail, i + 4 + size.length, true);
    if (child?.value !== ID.Timecode) continue; // the pattern inside media data, not a Cluster
    const w = new Walker(scale);
    w.walk(tail, i, tail.length, false);
    if (w.times.length) best = w.times;
    if (w.times.length >= 20) break;
  }
  return best;
}

export async function probeWebmFile(path: string, limits = { head: HEAD, tail: TAIL }): Promise<WebmProbe | null> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const read = async (pos: number, len: number) => {
      const buf = new Uint8Array(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    if (size <= limits.head + limits.tail) return probeWebmBytes(await read(0, size));
    // The first block can be a large key frame (several MB at 4K): read more until one is complete.
    let head = new Walker();
    for (let len = limits.head; ; len *= 4) {
      head = new Walker();
      const n = Math.min(len, size);
      head.walk(await read(0, n), 0, n, false);
      if (head.times.length || n === size) break;
    }
    if (!head.times.length) return null;
    // MediaRecorder starts a Cluster at each key frame (about every second here); read more if none is in the tail.
    let tailTimes: number[] | null = null;
    for (let len = limits.tail; ; len *= 4) {
      const n = Math.min(len, size);
      tailTimes = lastClusterTimes(await read(size - n, n), head.scale);
      if (tailTimes || n === size) break;
    }
    if (!tailTimes) return null;
    const all = [...head.times, ...tailTimes];
    return result(head.info, all, Math.min(...head.times), Math.max(...tailTimes), blockStep(tailTimes));
  } finally {
    await fh.close();
  }
}

/** `--probe-files` equivalent for the browser recording path: one entry per file name. */
export async function probeWebmFolder(dir: string, names: readonly string[]): Promise<ProbedFile[]> {
  const out: ProbedFile[] = [];
  for (const name of names) {
    try {
      const p = await probeWebmFile(join(dir, name));
      out.push(p
        ? { name, kind: p.kind, durationMs: p.durationMs, firstMs: p.firstMs, samples: p.blocks, width: p.width, height: p.height, sampleRate: p.sampleRate, channels: p.channels }
        : { name, error: 'no-blocks' });
    } catch (e) {
      out.push({ name, error: (e as NodeJS.ErrnoException).code ?? 'read' });
    }
  }
  return out;
}
