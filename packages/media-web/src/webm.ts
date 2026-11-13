import { ByteWriter, type Sink } from './bytes';

/**
 * WebM (Matroska subset) writer: EBML header, Segment with SeekHead, Info, Tracks,
 * Clusters of SimpleBlocks and Cues. Sizes and the duration are patched at the end so
 * the file is seekable. Written from the public element specification.
 */

export interface WebmVideoConfig {
  codec: 'V_VP9' | 'V_VP8' | 'V_AV1';
  width: number;
  height: number;
  codecPrivate?: Uint8Array;
}

export interface WebmAudioConfig {
  codec: 'A_OPUS';
  sampleRate: number;
  channels: number;
  codecPrivate?: Uint8Array;
}

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, MuxingApp: 0x4d80, WritingApp: 0x5741, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, CodecID: 0x86,
  CodecPrivate: 0x63a2, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
  Void: 0xec,
} as const;

function writeId(w: ByteWriter, id: number): void {
  if (id >= 0x1000000) w.u32(id);
  else if (id >= 0x10000) w.u24(id);
  else if (id >= 0x100) w.u16(id);
  else w.u8(id);
}

/** EBML variable-length size. `width` forces a fixed length (for later patching). */
function writeSize(w: ByteWriter, size: number, width?: number): void {
  let len = width ?? 1;
  // All-ones is reserved for "unknown", so the largest value for `len` bytes is 2^(7·len) − 2.
  if (!width) while (len < 8 && size >= 2 ** (7 * len) - 1) len++;
  const bytes = new Array<number>(len).fill(0);
  let v = size;
  for (let i = len - 1; i >= 0; i--) {
    bytes[i] = v % 256;
    v = Math.floor(v / 256);
  }
  bytes[0] = bytes[0]! | (0x80 >> (len - 1));
  for (const b of bytes) w.u8(b);
}

function uintBytes(v: number): number[] {
  const out: number[] = [];
  let x = v;
  do { out.unshift(x % 256); x = Math.floor(x / 256); } while (x > 0);
  return out;
}

function el(w: ByteWriter, id: number, body: (w: ByteWriter) => void): void {
  const inner = new ByteWriter(256);
  body(inner);
  const data = inner.result();
  writeId(w, id);
  writeSize(w, data.length);
  w.bytes(data);
}

const uint = (w: ByteWriter, id: number, v: number) => { const b = uintBytes(v); writeId(w, id); writeSize(w, b.length); for (const x of b) w.u8(x); };
const fixedUint = (w: ByteWriter, id: number, v: number, n: number) => { writeId(w, id); writeSize(w, n); const b = uintBytes(v); for (let i = 0; i < n - b.length; i++) w.u8(0); for (const x of b) w.u8(x); };
const str = (w: ByteWriter, id: number, s: string) => { writeId(w, id); writeSize(w, s.length); w.ascii(s); };
const bin = (w: ByteWriter, id: number, b: Uint8Array) => { writeId(w, id); writeSize(w, b.length); w.bytes(b); };
const float = (w: ByteWriter, id: number, v: number) => { writeId(w, id); writeSize(w, 8); w.f64(v); };

interface Block { track: number; data: Uint8Array; timeMs: number; key: boolean }

export class WebmWriter {
  private pos = 0;
  private segmentDataStart = 0;
  private segmentSizePos = 0;
  private seekHeadPos = 0;
  private durationPos = 0;
  private infoPos = 0;
  private tracksPos = 0;
  private cluster: { startMs: number; blocks: Block[] } | null = null;
  private cues: { timeMs: number; position: number }[] = [];
  private pendingAudio: Block[] = [];
  private lastVideoMs = -Infinity;
  private maxMs = 0;
  private started = false;
  private readonly videoTrack: number;
  private readonly audioTrack: number;

  constructor(private readonly opts: { video?: WebmVideoConfig; audio?: WebmAudioConfig; sink: Sink }) {
    this.videoTrack = opts.video ? 1 : 0;
    this.audioTrack = opts.audio ? (opts.video ? 2 : 1) : 0;
  }

  private async write(data: Uint8Array): Promise<void> {
    await this.opts.sink(data, null);
    this.pos += data.length;
  }

  async start(): Promise<void> {
    const w = new ByteWriter(1024);
    el(w, ID.EBML, (e) => {
      uint(e, ID.EBMLVersion, 1); uint(e, ID.EBMLReadVersion, 1); uint(e, ID.EBMLMaxIDLength, 4); uint(e, ID.EBMLMaxSizeLength, 8);
      str(e, ID.DocType, 'webm'); uint(e, ID.DocTypeVersion, 4); uint(e, ID.DocTypeReadVersion, 2);
    });
    writeId(w, ID.Segment);
    this.segmentSizePos = w.pos;
    writeSize(w, 0, 8); // patched in finish()
    this.segmentDataStart = w.pos;

    // SeekHead with fixed-width positions so it can be patched in place.
    this.seekHeadPos = w.pos;
    this.writeSeekHead(w, 0, 0, 0);

    this.infoPos = w.pos - this.segmentDataStart;
    el(w, ID.Info, (i) => {
      uint(i, ID.TimecodeScale, 1_000_000);
      str(i, ID.MuxingApp, 'Zeyvola');
      str(i, ID.WritingApp, 'Zeyvola');
      writeId(i, ID.Duration);
      writeSize(i, 8);
      this.durationRel = i.pos;
      i.f64(0);
    });
    // Locate the Duration payload inside the just-written Info element.
    this.durationPos = this.findDuration(w);

    this.tracksPos = w.pos - this.segmentDataStart;
    el(w, ID.Tracks, (t) => {
      if (this.opts.video) {
        const v = this.opts.video;
        el(t, ID.TrackEntry, (e) => {
          uint(e, ID.TrackNumber, this.videoTrack); uint(e, ID.TrackUID, 1); uint(e, ID.TrackType, 1); str(e, ID.CodecID, v.codec);
          if (v.codecPrivate) bin(e, ID.CodecPrivate, v.codecPrivate);
          el(e, ID.Video, (vv) => { uint(vv, ID.PixelWidth, v.width); uint(vv, ID.PixelHeight, v.height); });
        });
      }
      if (this.opts.audio) {
        const a = this.opts.audio;
        el(t, ID.TrackEntry, (e) => {
          uint(e, ID.TrackNumber, this.audioTrack); uint(e, ID.TrackUID, 2); uint(e, ID.TrackType, 2); str(e, ID.CodecID, a.codec);
          bin(e, ID.CodecPrivate, a.codecPrivate ?? opusHead(a.channels, a.sampleRate));
          uint(e, ID.CodecDelay, 6_500_000);
          uint(e, ID.SeekPreRoll, 80_000_000);
          el(e, ID.Audio, (aa) => { float(aa, ID.SamplingFrequency, a.sampleRate); uint(aa, ID.Channels, a.channels); });
        });
      }
    });
    await this.write(w.result());
    this.started = true;
  }

  private durationRel = 0;
  private findDuration(w: ByteWriter): number {
    // Duration payload = Info element start + id(4) + size(1 or more) + relative offset in body.
    const infoStart = this.segmentDataStart + this.infoPos;
    const bytes = w.result();
    const sizeByte = bytes[infoStart + 4]!;
    let sizeLen = 1;
    while (sizeLen < 8 && !(sizeByte & (0x80 >> (sizeLen - 1)))) sizeLen++;
    return infoStart + 4 + sizeLen + this.durationRel;
  }

  private writeSeekHead(w: ByteWriter, info: number, tracks: number, cues: number): void {
    el(w, ID.SeekHead, (s) => {
      for (const [id, p] of [[ID.Info, info], [ID.Tracks, tracks], [ID.Cues, cues]] as const) {
        el(s, ID.Seek, (k) => {
          const idb = new ByteWriter(4);
          writeId(idb, id);
          bin(k, ID.SeekID, idb.result());
          fixedUint(k, ID.SeekPosition, p, 8);
        });
      }
    });
  }

  async addVideo(data: Uint8Array, ptsUs: number, key: boolean): Promise<void> {
    if (!this.started) await this.start();
    const timeMs = Math.round(ptsUs / 1000);
    while (this.pendingAudio.length && this.pendingAudio[0]!.timeMs <= timeMs) await this.push(this.pendingAudio.shift()!);
    this.lastVideoMs = Math.max(this.lastVideoMs, timeMs);
    await this.push({ track: this.videoTrack, data, timeMs, key });
  }

  async addAudio(data: Uint8Array, ptsUs: number): Promise<void> {
    if (!this.started) await this.start();
    const block = { track: this.audioTrack, data, timeMs: Math.round(ptsUs / 1000), key: true };
    if (this.opts.video && block.timeMs > this.lastVideoMs) this.pendingAudio.push(block);
    else await this.push(block);
  }

  private async push(b: Block): Promise<void> {
    const c = this.cluster;
    const isVideoKey = b.track === this.videoTrack && b.key;
    const tooLong = c && b.timeMs - c.startMs > 30_000;
    const newOnKey = c && isVideoKey && b.timeMs - c.startMs >= 1000;
    const audioOnlySplit = c && !this.opts.video && b.timeMs - c.startMs >= 2000;
    // Late blocks (earlier than the cluster start) stay in this cluster with a negative
    // relative timecode, which SimpleBlock allows; clusters themselves never go backwards.
    if (!c || tooLong || newOnKey || audioOnlySplit) {
      await this.flushCluster();
      this.cluster = { startMs: b.timeMs, blocks: [] };
    }
    this.cluster!.blocks.push(b);
    this.maxMs = Math.max(this.maxMs, b.timeMs);
  }

  private async flushCluster(): Promise<void> {
    const c = this.cluster;
    if (!c || c.blocks.length === 0) return;
    this.cues.push({ timeMs: c.startMs, position: this.pos - this.segmentDataStart });
    c.blocks.sort((a, b) => a.timeMs - b.timeMs);
    const w = new ByteWriter(c.blocks.reduce((n, b) => n + b.data.length + 16, 64));
    el(w, ID.Cluster, (cl) => {
      uint(cl, ID.Timecode, c.startMs);
      for (const b of c.blocks) {
        writeId(cl, ID.SimpleBlock);
        writeSize(cl, b.data.length + 4);
        cl.u8(0x80 | b.track).i16(b.timeMs - c.startMs).u8(b.key ? 0x80 : 0).bytes(b.data);
      }
    });
    this.cluster = null;
    await this.write(w.result());
  }

  async finish(lastDurationMs = 0): Promise<number> {
    if (!this.started) await this.start();
    for (const a of this.pendingAudio.splice(0)) await this.push(a);
    await this.flushCluster();
    const cuesRel = this.pos - this.segmentDataStart;
    const w = new ByteWriter(1024);
    el(w, ID.Cues, (cs) => {
      for (const cue of this.cues) {
        el(cs, ID.CuePoint, (p) => {
          uint(p, ID.CueTime, cue.timeMs);
          el(p, ID.CueTrackPositions, (t) => { uint(t, ID.CueTrack, this.videoTrack || this.audioTrack); uint(t, ID.CueClusterPosition, cue.position); });
        });
      }
    });
    await this.write(w.result());
    // Patch: segment size, seek head, duration.
    const seg = new ByteWriter(8);
    writeSize(seg, this.pos - this.segmentDataStart, 8);
    await this.opts.sink(seg.result(), this.segmentSizePos);
    const sh = new ByteWriter(128);
    this.writeSeekHead(sh, this.infoPos, this.tracksPos, cuesRel);
    await this.opts.sink(sh.result(), this.seekHeadPos);
    const dur = new ByteWriter(8);
    dur.f64(this.maxMs + lastDurationMs);
    await this.opts.sink(dur.result(), this.durationPos);
    return this.pos;
  }
}

/** Minimal OpusHead (RFC 7845 §5.1) for mono/stereo, channel mapping family 0. */
export function opusHead(channels: number, sampleRate: number, preSkip = 312): Uint8Array {
  const w = new ByteWriter(19);
  w.ascii('OpusHead').u8(1).u8(channels);
  // Little-endian fields.
  w.u8(preSkip & 255).u8(preSkip >> 8);
  w.u8(sampleRate & 255).u8((sampleRate >> 8) & 255).u8((sampleRate >> 16) & 255).u8((sampleRate >>> 24) & 255);
  w.u8(0).u8(0).u8(0);
  return w.result();
}
