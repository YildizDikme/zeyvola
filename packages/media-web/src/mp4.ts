import { ByteWriter, box, fullBox, type Sink } from './bytes';

/**
 * Progressive MP4 writer (ISO/IEC 14496-12 structure): ftyp, one growing mdat, and the
 * moov written at the end. Samples stream to the sink as they arrive, so memory stays
 * flat for long exports. Written from the public box layout; no third-party code.
 */

export interface Mp4VideoConfig {
  codec: 'avc1' | 'hvc1' | 'vp09' | 'vp08';
  width: number;
  height: number;
  /** avcC / hvcC bytes from the encoder's decoderConfig.description (may arrive later). Not used for VP8/VP9. */
  description?: Uint8Array;
  /** VP8/VP9: codec string (vp0N.PP.LL.DD[...]); the vpcC box is built from it. */
  codecString?: string;
}

export interface Mp4AudioConfig {
  codec: 'mp4a' | 'opus';
  sampleRate: number;
  channels: number;
  /** AAC: AudioSpecificConfig. Opus: OpusHead (optional). */
  description?: Uint8Array;
}

interface Sample {
  offset: number;
  size: number;
  pts: number; // track timescale
  duration: number;
  key: boolean;
}

interface Track {
  id: number;
  timescale: number;
  samples: Sample[];
}

const VIDEO_TIMESCALE = 90_000;
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

export class Mp4Writer {
  private pos = 0;
  private mdatStart = 0;
  private video: Track | null = null;
  private audio: Track | null = null;
  private pendingAudio: { data: Uint8Array; ptsUs: number; durationUs: number }[] = [];
  private lastVideoPtsUs = -Infinity;
  private started = false;

  constructor(private readonly opts: { video?: Mp4VideoConfig; audio?: Mp4AudioConfig; sink: Sink }) {
    if (opts.video) this.video = { id: 1, timescale: VIDEO_TIMESCALE, samples: [] };
    if (opts.audio) this.audio = { id: opts.video ? 2 : 1, timescale: opts.audio.sampleRate, samples: [] };
  }

  private async write(data: Uint8Array): Promise<void> {
    await this.opts.sink(data, null);
    this.pos += data.length;
  }

  async start(): Promise<void> {
    const w = new ByteWriter(64);
    box(w, 'ftyp', (b) => {
      b.ascii('isom').u32(0x200);
      const codec = this.opts.video?.codec;
      for (const brand of ['isom', 'iso2', ...(codec === 'hvc1' ? ['iso6'] : codec === 'vp09' || codec === 'vp08' ? [] : ['avc1']), 'mp41']) b.ascii(brand);
    });
    this.mdatStart = w.pos;
    w.u32(1).ascii('mdat').u64(0); // 64-bit size, patched in finish()
    await this.write(w.result());
    this.started = true;
  }

  async addVideo(data: Uint8Array, ptsUs: number, durationUs: number, key: boolean): Promise<void> {
    if (!this.video) throw new Error('Video izi yok');
    if (!this.started) await this.start();
    // Interleave queued audio up to this video time for smoother progressive playback.
    while (this.pendingAudio.length && this.pendingAudio[0]!.ptsUs <= ptsUs) {
      const a = this.pendingAudio.shift()!;
      await this.writeAudio(a.data, a.ptsUs, a.durationUs);
    }
    const ts = this.video.timescale;
    this.video.samples.push({
      offset: this.pos, size: data.length, key,
      pts: Math.round((ptsUs * ts) / 1e6), duration: Math.max(1, Math.round((durationUs * ts) / 1e6)),
    });
    this.lastVideoPtsUs = Math.max(this.lastVideoPtsUs, ptsUs);
    await this.write(data);
  }

  async addAudio(data: Uint8Array, ptsUs: number, durationUs: number): Promise<void> {
    if (!this.audio) throw new Error('Ses izi yok');
    if (!this.started) await this.start();
    if (this.video && ptsUs > this.lastVideoPtsUs) {
      this.pendingAudio.push({ data, ptsUs, durationUs });
      return;
    }
    await this.writeAudio(data, ptsUs, durationUs);
  }

  private async writeAudio(data: Uint8Array, ptsUs: number, durationUs: number): Promise<void> {
    const t = this.audio!;
    t.samples.push({
      offset: this.pos, size: data.length, key: true,
      pts: Math.round((ptsUs * t.timescale) / 1e6), duration: Math.max(1, Math.round((durationUs * t.timescale) / 1e6)),
    });
    await this.write(data);
  }

  /** Writes the moov box and patches the mdat size. Returns the total file size. */
  async finish(): Promise<number> {
    if (!this.started) await this.start();
    for (const a of this.pendingAudio.splice(0)) await this.writeAudio(a.data, a.ptsUs, a.durationUs);
    const mdatSize = this.pos - this.mdatStart;
    const patch = new ByteWriter(8);
    patch.u64(mdatSize);
    await this.opts.sink(patch.result(), this.mdatStart + 8);

    const w = new ByteWriter(4096);
    const durMs = (t: Track) => {
      const end = t.samples.reduce((m, s) => Math.max(m, s.pts + s.duration), 0);
      const start = t.samples.reduce((m, s) => Math.min(m, s.pts), Infinity);
      return Math.round(((end - (Number.isFinite(start) ? start : 0)) * 1000) / t.timescale);
    };
    const tracks = [this.video, this.audio].filter((t): t is Track => !!t && t.samples.length > 0);
    const movieDuration = Math.max(0, ...tracks.map(durMs));
    box(w, 'moov', (m) => {
      fullBox(m, 'mvhd', 0, 0, (b) => {
        b.u32(0).u32(0).u32(1000).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10);
        for (const v of MATRIX) b.u32(v);
        b.zeros(24).u32(tracks.length + 1);
      });
      for (const t of tracks) this.writeTrak(m, t, durMs(t));
    });
    await this.write(w.result());
    return this.pos;
  }

  private writeTrak(w: ByteWriter, t: Track, durationMs: number): void {
    const isVideo = t === this.video;
    const samples = t.samples;
    // Decode order is arrival order. DTS = sorted PTS; composition offsets cover reordering.
    const sortedPts = samples.map((s) => s.pts).sort((a, b) => a - b);
    const firstPts = sortedPts[0] ?? 0;
    let shift = 0;
    for (let i = 0; i < samples.length; i++) shift = Math.max(shift, sortedPts[i]! - samples[i]!.pts);
    const dts = sortedPts.map((p) => p - firstPts - shift);
    const cto = samples.map((s, i) => s.pts - firstPts - dts[i]!);
    const needCtts = cto.some((c) => c !== 0);
    const trackDuration = Math.round((durationMs * t.timescale) / 1000);

    box(w, 'trak', (tr) => {
      fullBox(tr, 'tkhd', 0, 3, (b) => {
        b.u32(0).u32(0).u32(t.id).u32(0).u32(durationMs).zeros(8).u16(0).u16(0).u16(isVideo ? 0 : 0x0100).u16(0);
        for (const v of MATRIX) b.u32(v);
        if (isVideo) b.u32(this.opts.video!.width * 65536).u32(this.opts.video!.height * 65536);
        else b.u32(0).u32(0);
      });
      if (shift > 0) {
        box(tr, 'edts', (e) => fullBox(e, 'elst', 0, 0, (b) => {
          b.u32(1).u32(durationMs).u32(shift).u16(1).u16(0);
        }));
      }
      box(tr, 'mdia', (md) => {
        fullBox(md, 'mdhd', 0, 0, (b) => { b.u32(0).u32(0).u32(t.timescale).u32(trackDuration).u16(0x55c4).u16(0); });
        fullBox(md, 'hdlr', 0, 0, (b) => {
          b.u32(0).ascii(isVideo ? 'vide' : 'soun').zeros(12).ascii(isVideo ? 'VideoHandler' : 'SoundHandler').u8(0);
        });
        box(md, 'minf', (mi) => {
          if (isVideo) fullBox(mi, 'vmhd', 0, 1, (b) => b.zeros(8));
          else fullBox(mi, 'smhd', 0, 0, (b) => b.zeros(4));
          box(mi, 'dinf', (d) => fullBox(d, 'dref', 0, 0, (b) => { b.u32(1); fullBox(b, 'url ', 0, 1, () => undefined); }));
          box(mi, 'stbl', (st) => {
            fullBox(st, 'stsd', 0, 0, (b) => { b.u32(1); if (isVideo) this.writeVideoEntry(b); else this.writeAudioEntry(b); });
            // stts: run-length of decode deltas.
            fullBox(st, 'stts', 0, 0, (b) => {
              const runs: [number, number][] = [];
              for (let i = 0; i < samples.length; i++) {
                const delta = i + 1 < samples.length ? dts[i + 1]! - dts[i]! : samples[i]!.duration;
                const last = runs[runs.length - 1];
                if (last && last[1] === delta) last[0]++;
                else runs.push([1, delta]);
              }
              b.u32(runs.length);
              for (const [c, d] of runs) b.u32(c).u32(d);
            });
            if (needCtts) {
              fullBox(st, 'ctts', 1, 0, (b) => {
                const runs: [number, number][] = [];
                for (const c of cto) {
                  const last = runs[runs.length - 1];
                  if (last && last[1] === c) last[0]++;
                  else runs.push([1, c]);
                }
                b.u32(runs.length);
                for (const [n, c] of runs) b.u32(n).i32(c);
              });
            }
            if (isVideo && samples.some((s) => !s.key)) {
              fullBox(st, 'stss', 0, 0, (b) => {
                const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
                b.u32(keys.length);
                for (const k of keys) b.u32(k);
              });
            }
            fullBox(st, 'stsc', 0, 0, (b) => { b.u32(1).u32(1).u32(1).u32(1); });
            fullBox(st, 'stsz', 0, 0, (b) => { b.u32(0).u32(samples.length); for (const s of samples) b.u32(s.size); });
            fullBox(st, 'co64', 0, 0, (b) => { b.u32(samples.length); for (const s of samples) b.u64(s.offset); });
          });
        });
      });
    });
  }

  private writeVideoEntry(w: ByteWriter): void {
    const v = this.opts.video!;
    box(w, v.codec, (b) => {
      b.zeros(6).u16(1).zeros(16).u16(v.width).u16(v.height).u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).i16(-1);
      if (v.codec === 'vp09' || v.codec === 'vp08') {
        // Colour is carried in vpcC (VP Codec ISO Media File Format Binding); no colr box.
        fullBox(b, 'vpcC', 1, 0, (c) => c.bytes(vpcC(v.codecString ?? (v.codec === 'vp08' ? 'vp08.00.10.08' : 'vp09.00.41.08'))));
      } else {
        if (!v.description) throw new Error('Kodlayıcı yapılandırması (avcC) alınamadı');
        box(b, v.codec === 'avc1' ? 'avcC' : 'hvcC', (c) => c.bytes(v.description!));
        // BT.709, limited range — matches what the encoders produce from sRGB canvases.
        box(b, 'colr', (c) => { c.ascii('nclx').u16(1).u16(1).u16(1).u8(0); });
      }
      box(b, 'pasp', (c) => { c.u32(1).u32(1); });
    });
  }

  private writeAudioEntry(w: ByteWriter): void {
    const a = this.opts.audio!;
    box(w, a.codec === 'mp4a' ? 'mp4a' : 'Opus', (b) => {
      b.zeros(6).u16(1).zeros(8).u16(a.channels).u16(16).u16(0).u16(0).u32(Math.min(65535, a.sampleRate) * 65536);
      if (a.codec === 'mp4a') {
        const asc = a.description ?? defaultAacConfig(a.sampleRate, a.channels);
        fullBox(b, 'esds', 0, 0, (e) => {
          const dsi = descriptor(0x05, asc);
          const dcd = descriptor(0x04, concat([new Uint8Array([0x40, 0x15, 0, 0, 0, 0, 0x01, 0xf4, 0x00, 0, 0x01, 0xf4, 0x00]), dsi]));
          const sl = descriptor(0x06, new Uint8Array([0x02]));
          e.bytes(descriptor(0x03, concat([new Uint8Array([0, a.channels > 2 ? 2 : 1, 0]), dcd, sl])));
        });
      } else {
        const preSkip = a.description && a.description.length >= 12 ? a.description[10]! | (a.description[11]! << 8) : 312;
        box(b, 'dOps', (d) => { d.u8(0).u8(a.channels).u16(preSkip).u32(a.sampleRate).i16(0).u8(0); });
      }
    });
  }
}

/**
 * VPCodecConfigurationRecord (vpcC version 1 payload) from a VP9 or VP8 codec string
 * vp0N.PP.LL.DD[.CC.cp.tc.mc.FF]; omitted fields take the binding's defaults
 * (4:2:0 colocated, BT.709, legal range). VP8 is profile 0, 8-bit only. webmproject.org/vp9/mp4/
 */
export function vpcC(codecString: string): Uint8Array {
  const parts = codecString.split('.');
  if ((parts[0] !== 'vp09' && parts[0] !== 'vp08') || (parts.length !== 4 && parts.length !== 9)) throw new Error(`Geçersiz VP8/VP9 codec dizesi: ${codecString}`);
  const [profile, level, bitDepth, chroma = 1, primaries = 1, transfer = 1, matrix = 1, fullRange = 0] = parts.slice(1).map((x) => Number.parseInt(x, 10));
  if (parts[0] === 'vp08' ? profile !== 0 || bitDepth !== 8 : ![8, 10, 12].includes(bitDepth!)) throw new Error(`Geçersiz bit derinliği ya da profil: ${codecString}`);
  return new Uint8Array([profile!, level!, (bitDepth! << 4) | (chroma << 1) | (fullRange & 1), primaries, transfer, matrix, 0, 0]);
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 5);
  out[0] = tag;
  let len = payload.length;
  // 4-byte expandable length (always 4 bytes for simplicity).
  out[1] = 0x80 | ((len >> 21) & 0x7f);
  out[2] = 0x80 | ((len >> 14) & 0x7f);
  out[3] = 0x80 | ((len >> 7) & 0x7f);
  out[4] = len & 0x7f;
  out.set(payload, 5);
  len = 0;
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** AAC-LC AudioSpecificConfig for when the encoder provides none. */
export function defaultAacConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}
