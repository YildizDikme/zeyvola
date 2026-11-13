import { Compositor } from '@zeyvola/compositor';
import { Mp4Writer, WebmWriter, type Mp4VideoConfig, type Sink } from '@zeyvola/media-web';
import {
  activeVariant, evaluate, layoutSegments, sequenceDuration, type ID, type PreparedCursor, type Project, type Recording, type SourceKind,
} from '@zeyvola/project-model';
import { TICKS_PER_SECOND, frameCount, frameToTicks, type Ticks } from '@zeyvola/timing';
import { codecString, PROFILE, type ExportFormat, type ExportPlan } from '../../shared/distribution';
import type { EncoderInfo, ExportTarget } from '@zeyvola/protocol';
import { api } from '../api';
import { t } from '../i18n';
import { probe } from '../perf-probe';
import { chooseRoute, HNS, needsMfProbe, nv12Size, rgbaToNv12, toPcm16Stereo, writtenFormat, type ExportRoute } from './route';

export type { ExportFormat };

export interface ExportOptions {
  variantId: ID;
  format: ExportFormat;
  resolution: '1080' | '2160';
  fps: 30 | 60;
  quality: 'standard' | 'high';
  includeAudio: boolean;
  /** Where to write (from api.exportDefaultTarget / exportChooseTarget); main's default folder when absent. */
  target?: ExportTarget;
  /** Which encoder writes it (checkExportSupport); WebCodecs when absent. */
  route?: ExportRoute;
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finishing' | 'done' | 'error' | 'cancelled';
  frame: number;
  total: number;
  rate: number;
  etaSeconds: number;
  encoder?: string;
  path?: string;
  bytes?: number;
  message?: string;
  /** The format actually written (WebM when it stood in for MP4). */
  written?: ExportFormat;
  /** Set when WebM was written instead of MP4: why, in the user's language. */
  fallback?: string;
}

const SAMPLE_RATE = 48_000;

/** The file name an export suggests, without extension: project and format ("Demo 16x9"). */
export function exportBaseName(project: Project, variantId: ID): string {
  return `${project.name} ${activeVariant(project, variantId).name.replace(':', 'x')}`;
}

export function outputSize(project: Project, o: Pick<ExportOptions, 'variantId' | 'resolution'>): { width: number; height: number } {
  const v = activeVariant(project, o.variantId);
  const k = o.resolution === '2160' ? 2 : 1;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(v.width * k), height: even(v.height * k) };
}

/** Target bitrate; `scale` is the codec's factor relative to H.264 (shared/distribution.ts). */
function bitrateFor(width: number, height: number, fps: number, quality: 'standard' | 'high', scale: number): number {
  const pixels = width * height;
  const base = pixels >= 3840 * 2160 * 0.9 ? 40e6 : pixels >= 2560 * 1440 * 0.9 ? 22e6 : 12e6;
  const fpsK = fps >= 50 ? 1.45 : 1;
  const q = quality === 'high' ? 1 : 0.68;
  return Math.round(base * fpsK * q * scale);
}

function planFor(format: ExportFormat): ExportPlan {
  const plan = PROFILE.exports[format];
  if (!plan) throw new Error(t("Bu dosya türü bu sürümde yok."));
  return plan;
}

const VIDEO_LABEL = { avc1: 'H.264', vp09: 'VP9', vp8: 'VP8' } as const;

/**
 * Encoder for `format` in this distribution (shared/distribution.ts). H.264 is asked for
 * with "prefer-hardware" only, so the operating system's encoder is used and Electron's
 * bundled software encoder (OpenH264) never is; a device without one gets an error.
 */
export async function pickVideoConfig(format: ExportFormat, width: number, height: number, fps: number, bitrate: number): Promise<{ config: VideoEncoderConfig; label: string }> {
  const plan = planFor(format);
  for (const choice of plan.video) {
    const codec = codecString(choice, width, height, fps);
    for (const hw of choice.accel) {
      const config: VideoEncoderConfig = {
        codec, width, height, bitrate, framerate: fps, hardwareAcceleration: hw, latencyMode: 'quality', bitrateMode: 'variable',
        ...(choice.codec === 'avc1' ? { avc: { format: 'avc' } } : {}),
      };
      try {
        const s = await VideoEncoder.isConfigSupported(config);
        if (s.supported) return { config: s.config ?? config, label: `${t(VIDEO_LABEL[choice.codec])} · ${hw === 'prefer-hardware' ? t("donanım") : t("otomatik")}` };
      } catch { /* try next */ }
    }
  }
  throw new Error(plan.video[0]?.codec === 'avc1'
    ? t("Bu cihazda H.264 donanım kodlayıcısı bulunamadı, bu yüzden MP4 yazılamıyor. WebM biçimini kullanın.")
    : t("Bu cihazda VP9/VP8 kodlayıcı bulunamadı."));
}

async function pickAudioConfig(format: ExportFormat): Promise<AudioEncoderConfig | null> {
  for (const codec of planFor(format).audio) {
    const config: AudioEncoderConfig = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192_000 };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return config;
    } catch { /* next */ }
  }
  return null;
}

function noAudioEncoder(format: ExportFormat): Error {
  return new Error(planFor(format).audio[0] === 'mp4a.40.2'
    ? t("Bu cihazda AAC ses kodlayıcısı bulunamadı, bu yüzden MP4 yazılamıyor. WebM biçimini kullanın ya da sesi kapatın.")
    : t("Bu cihazda Opus ses kodlayıcısı bulunamadı. Sesi kapatıp yeniden deneyin."));
}

export type ExportSupport =
  | { ok: true; encoder: string; route: ExportRoute; written: ExportFormat; notice?: string }
  | { ok: false; message: string; suggestWebm: boolean };

/**
 * What main can offer besides WebCodecs. The route a test run forces is asked once per window
 * without the probe (cheap); the Windows helper's test encode runs only when needed, also once.
 */
let forcedRoute: Promise<EncoderInfo['route']> | null = null;
let probed: Promise<EncoderInfo> | null = null;
function askForcedRoute(): Promise<EncoderInfo['route']> {
  forcedRoute ??= api.exportEncoderInfo(false).then((i) => i.route, () => undefined);
  return forcedRoute;
}
function askMfProbe(): Promise<EncoderInfo> {
  probed ??= api.exportEncoderInfo(true).catch(() => ({ mf: { available: false, reason: 'ipc' } }));
  return probed;
}

/** Why WebM is written instead of MP4, for the export window (before) and its result line (after). */
export function fallbackNotice(route: ExportRoute): string | undefined {
  if (route.kind !== 'webm-fallback') return undefined;
  return route.reason === 'no-aac'
    ? t("Bu bilgisayarda MP4 için AAC ses kodlayıcısı yok. Video bu yüzden WebM (VP9 + Opus) olarak kaydedilecek.")
    : t("Bu bilgisayarda MP4 için H.264 kodlayıcısı yok. Video bu yüzden WebM (VP9 + Opus) olarak kaydedilecek.");
}

/**
 * Asks the encoders before the export starts and picks the route (route.ts): hardware H.264 →
 * Windows' Media Foundation encoders through the helper → WebM instead of MP4, said plainly.
 * A device never gets a different file than the window told it about.
 */
export async function checkExportSupport(project: Project, o: Pick<ExportOptions, 'variantId' | 'format' | 'resolution' | 'fps' | 'quality' | 'includeAudio'>): Promise<ExportSupport> {
  const suggestWebm = o.format !== 'webm' && PROFILE.formats.includes('webm');
  const webCodecs = async (format: ExportFormat): Promise<{ label: string } | { error: string }> => {
    try {
      const { width, height } = outputSize(project, o);
      const bitrate = bitrateFor(width, height, o.fps, o.quality, planFor(format).video[0]?.bitrateScale ?? 1);
      const { label } = await pickVideoConfig(format, width, height, o.fps, bitrate);
      const audio = o.includeAudio ? await pickAudioConfig(format) : null;
      if (o.includeAudio && !audio) throw noAudioEncoder(format);
      return { label: `${label}${audio ? ` + ${audio.codec === 'opus' ? 'Opus' : 'AAC'}` : ''}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  if (o.format !== 'mp4') {
    const r = await webCodecs(o.format);
    return 'label' in r ? { ok: true, encoder: r.label, route: { kind: 'webcodecs' }, written: o.format } : { ok: false, message: r.error, suggestWebm };
  }
  const { width, height } = outputSize(project, o);
  const hardwareH264 = await pickVideoConfig('mp4', width, height, o.fps, bitrateFor(width, height, o.fps, o.quality, 1)).then(() => true, () => false);
  const webCodecsAac = o.includeAudio ? (await pickAudioConfig('mp4')) !== null : true;
  const forced = await askForcedRoute();
  const info = needsMfProbe({ format: 'mp4', includeAudio: o.includeAudio, hardwareH264, webCodecsAac, forced }) ? await askMfProbe() : null;
  const route = chooseRoute({
    format: 'mp4', platform: window.zeyvola?.platform ?? '', includeAudio: o.includeAudio, hardwareH264, webCodecsAac,
    mfAvailable: info?.mf.available ?? false, webmOffered: PROFILE.formats.includes('webm'), forced,
  });
  if (route.kind === 'mf') {
    return { ok: true, encoder: `${t("H.264 · Windows yazılım kodlayıcısı (daha yavaş)")}${o.includeAudio ? ' + AAC' : ''}`, route, written: 'mp4' };
  }
  if (route.kind === 'webm-fallback') {
    const r = await webCodecs('webm');
    if ('error' in r) return { ok: false, message: r.error, suggestWebm: false };
    return { ok: true, encoder: r.label, route, written: 'webm', notice: fallbackNotice(route) };
  }
  if (route.kind === 'unsupported') return { ok: false, message: route.reason === 'no-aac' ? noAudioEncoder('mp4').message : t("Bu cihazda H.264 donanım kodlayıcısı bulunamadı, bu yüzden MP4 yazılamıyor. WebM biçimini kullanın."), suggestWebm: false };
  const r = await webCodecs('mp4');
  return 'label' in r ? { ok: true, encoder: r.label, route, written: 'mp4' } : { ok: false, message: r.error, suggestWebm };
}

/** Batches small appends into larger IPC writes. */
function bufferedSink(exportId: string): { sink: Sink; flush: () => Promise<void> } {
  let parts: Uint8Array[] = [];
  let size = 0;
  let chain = Promise.resolve();
  const flush = async () => {
    if (size === 0) return chain;
    const data = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { data.set(p, o); o += p.length; }
    parts = [];
    size = 0;
    chain = chain.then(() => api.exportWrite(exportId, null, data));
    return chain;
  };
  const sink: Sink = async (data, position) => {
    if (position === null) {
      parts.push(data.slice());
      size += data.length;
      if (size >= 4 * 1024 * 1024) await flush();
      return;
    }
    await flush();
    chain = chain.then(() => api.exportWrite(exportId, position, data.slice()));
    await chain;
  };
  return { sink, flush: async () => { await flush(); await chain; } };
}

// ─── Audio ────────────────────────────────────────────────────────────────────

async function decodeSource(url: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Mixes mic + system audio along the edited timeline into stereo 48 kHz PCM. */
export async function mixTimelineAudio(project: Project, mediaBase: string, signal?: AbortSignal): Promise<[Float32Array, Float32Array] | null> {
  const duration = sequenceDuration(project);
  const length = Math.ceil((duration / TICKS_PER_SECOND) * SAMPLE_RATE);
  if (length === 0) return null;
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const decoded = new Map<string, AudioBuffer | null>();
  const url = (file: string) => mediaBase + file.split('/').map(encodeURIComponent).join('/');
  const kinds: SourceKind[] = ['mic', 'system'];
  for (const rec of Object.values(project.recordings)) {
    for (const k of kinds) {
      const src = rec.sources[k];
      if (src) decoded.set(`${rec.id}/${k}`, await decodeSource(url(src.file), ctx));
      if (signal?.aborted) return null;
    }
  }
  if ([...decoded.values()].every((b) => !b)) return null;
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (const pl of layoutSegments(project)) {
    const rec: Recording | undefined = project.recordings[pl.segment.recordingId];
    if (!rec) continue;
    for (const k of kinds) {
      const mix = k === 'mic' ? project.audio.mic : project.audio.system;
      const buf = decoded.get(`${rec.id}/${k}`);
      const src = rec.sources[k];
      if (!buf || !src || mix.muted || mix.gain <= 0) continue;
      const offset = src.startOffset + (rec.syncOffsets[k] ?? 0);
      const outStart = Math.round((pl.timelineStart / TICKS_PER_SECOND) * SAMPLE_RATE);
      const count = Math.round(((pl.timelineEnd - pl.timelineStart) / TICKS_PER_SECOND) * SAMPLE_RATE);
      const inStart = Math.round(((pl.segment.sourceStart - offset) / TICKS_PER_SECOND) * buf.sampleRate);
      const c0 = buf.getChannelData(0);
      const c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
      const ratio = buf.sampleRate / SAMPLE_RATE;
      for (let i = 0; i < count; i++) {
        const j = Math.floor(inStart + i * ratio);
        if (j < 0 || j >= c0.length) continue;
        const o = outStart + i;
        if (o >= length) break;
        L[o]! += c0[j]! * mix.gain;
        R[o]! += c1[j]! * mix.gain;
      }
    }
  }
  // Soft limiter so summed sources never clip harshly.
  for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) { const v = ch[i]!; ch[i] = v > 1 || v < -1 ? Math.tanh(v) : v; }
  return [L, R];
}

// ─── Frame sources ────────────────────────────────────────────────────────────

const MEDIA_WAIT_MS = 8000;

/** A source frame could not be read; the export stops instead of drawing a frame without it. */
export class MediaReadError extends Error {
  override name = 'MediaReadError';
}

export class ExportMedia {
  private els = new Map<string, HTMLVideoElement>();
  constructor(private readonly mediaBase: string, private readonly signal?: AbortSignal) {}

  private el(file: string): HTMLVideoElement {
    let v = this.els.get(file);
    if (!v) {
      v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'auto';
      v.src = this.mediaBase + file.split('/').map(encodeURIComponent).join('/');
      this.els.set(file, v);
    }
    return v;
  }

  private drop(file: string): void {
    const v = this.els.get(file);
    if (!v) return;
    v.removeAttribute('src');
    v.load();
    this.els.delete(file);
  }

  /**
   * Seeks to `seconds` and resolves once that frame is decoded. A timeout or media error is
   * retried once on a fresh element; after that it throws a MediaReadError naming the file.
   */
  async frameAt(file: string, seconds: number): Promise<HTMLVideoElement> {
    return retryOnce(
      () => this.tryFrameAt(file, seconds),
      () => this.drop(file),
      (e) => {
        if (isAbort(e)) return e;
        const name = file.split('/').pop() ?? file;
        return new MediaReadError(t("Kaynak video okunamadı: {file}. Dosya bozuk ya da eksik olabilir.", { file: name }));
      },
    );
  }

  private async tryFrameAt(file: string, seconds: number): Promise<HTMLVideoElement> {
    const v = this.el(file);
    if (v.error) throw new Error(v.error.message || `media error ${v.error.code}`);
    if (v.readyState < 1) await waitFor(v, 'loadedmetadata', MEDIA_WAIT_MS, this.signal);
    const target = Math.max(0, Math.min(seconds, (Number.isFinite(v.duration) ? v.duration : seconds) - 0.001));
    if (Math.abs(v.currentTime - target) > 0.0005 || v.readyState < 2) {
      const done = waitFor(v, 'seeked', MEDIA_WAIT_MS, this.signal);
      v.currentTime = target;
      await done;
    }
    if (v.readyState < 2) throw new Error('frame not decoded');
    return v;
  }

  dispose(): void {
    for (const v of this.els.values()) { v.removeAttribute('src'); v.load(); }
    this.els.clear();
  }
}

const isAbort = (e: unknown): boolean => (e as Error | null)?.name === 'AbortError';
const abortError = () => new DOMException(t("İptal edildi"), 'AbortError');

/** Runs `attempt`; on failure calls `reset` and tries once more, then throws `wrap(error)`. Aborts are never retried. */
export async function retryOnce<T>(attempt: () => Promise<T>, reset: () => void, wrap: (e: unknown) => unknown): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (isAbort(e)) throw e;
    reset();
  }
  try {
    return await attempt();
  } catch (e) {
    throw wrap(e);
  }
}

/** Resolves on `event`; rejects on timeout, a media error or abort. */
function waitFor(el: HTMLMediaElement, event: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const done = (err?: unknown) => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };
    const onEvent = () => done();
    const onError = () => done(new Error(el.error?.message || `media error ${el.error?.code ?? ''}`));
    const onAbort = () => done(abortError());
    const timer = setTimeout(() => done(new Error(`${event} timeout`)), ms);
    el.addEventListener(event, onEvent);
    el.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);
  });
}

// ─── Compositor lifetime ──────────────────────────────────────────────────────

export interface CompositorLike {
  readonly lost: boolean;
  dispose(): void;
}

/**
 * Owns a compositor and replaces it when the browser takes its WebGL context away. `draw`
 * runs the drawing (and whatever reads the canvas) and repeats it on a new compositor if the
 * context was lost meanwhile, so a lost context never yields a blank picture. After
 * `maxRebuilds` replacements it throws instead.
 */
export class CompositorHolder<C extends CompositorLike> {
  private current: C | null = null;
  private rebuilds = 0;
  constructor(private readonly make: () => C, private readonly maxRebuilds = 3) {}

  get(): C {
    if (this.current && !this.current.lost) return this.current;
    if (this.current) {
      this.current.dispose();
      this.current = null;
      if (++this.rebuilds > this.maxRebuilds) throw new Error(t("Ekran kartı bağlamı tekrar tekrar kayboldu; dışa aktarma durduruldu. Diğer pencereleri kapatıp yeniden deneyin."));
    }
    this.current = this.make();
    return this.current;
  }

  /** `discard` frees a result drawn on a context that was lost meanwhile. */
  draw<T>(fn: (comp: C) => T, discard?: (result: T) => void): T {
    for (;;) {
      const comp = this.get();
      const result = fn(comp);
      if (!comp.lost) return result;
      discard?.(result);
    }
  }

  dispose(): void {
    this.current?.dispose();
    this.current = null;
  }
}

const newCanvasCompositor = (opts?: { preserveDrawingBuffer?: boolean }) => new Compositor(document.createElement('canvas'), opts);

/** One compositor for every privacy check picture in this window (see CompositorHolder). */
let stills: CompositorHolder<Compositor> | null = null;

/** Renders timeline time `t` exactly as the export would (used for privacy check thumbnails). */
export async function renderStill(project: Project, cursors: Record<ID, PreparedCursor | undefined>, mediaBase: string, t: Ticks, variantId: ID, size: { width: number; height: number }, media?: ExportMedia): Promise<string> {
  const own = !media;
  const m = media ?? new ExportMedia(mediaBase);
  try {
    const plan = evaluate(project, t, { variantId, cursors, size });
    const rec = plan.recordingId ? project.recordings[plan.recordingId] : undefined;
    const screen = rec?.sources.screen && plan.screen ? await m.frameAt(rec.sources.screen.file, plan.screen.mediaTime / TICKS_PER_SECOND) : null;
    const camera = rec?.sources.camera && plan.camera ? await m.frameAt(rec.sources.camera.file, plan.camera.mediaTime / TICKS_PER_SECOND) : null;
    // A holder that has used up its rebuilds starts over: each picture gets a fresh chance.
    stills ??= new CompositorHolder(() => newCanvasCompositor({ preserveDrawingBuffer: true }));
    const holder = stills;
    try {
      return holder.draw((comp) => {
        comp.render(plan, {
          screen, screenSize: screen ? { width: screen.videoWidth, height: screen.videoHeight } : undefined,
          camera, cameraSize: camera ? { width: camera.videoWidth, height: camera.videoHeight } : undefined,
        });
        return (comp.canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.8);
      });
    } catch (e) {
      holder.dispose();
      if (stills === holder) stills = null;
      throw e;
    }
  } finally {
    if (own) m.dispose();
  }
}

// ─── Encoder errors ───────────────────────────────────────────────────────────

/** First error of an export (encoder callback, muxer write); wakes anything waiting on it. */
export class Failure {
  error: Error | null = null;
  private listeners = new Set<(e: Error) => void>();

  set(e: unknown): void {
    if (this.error) return;
    this.error = e instanceof Error ? e : new Error(String(e));
    for (const l of [...this.listeners]) l(this.error);
    this.listeners.clear();
  }

  throwIfSet(): void {
    if (this.error) throw this.error;
  }

  /** Rejects with the failure as soon as there is one, otherwise settles like `p`. */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.error) { p.catch(() => undefined); return Promise.reject(this.error); }
    return new Promise<T>((resolve, reject) => {
      const l = (e: Error) => reject(e);
      this.listeners.add(l);
      p.then(resolve, reject).finally(() => this.listeners.delete(l));
    });
  }
}

interface QueueingEncoder {
  readonly encodeQueueSize: number;
  readonly state: string;
  addEventListener(type: 'dequeue', fn: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: 'dequeue', fn: () => void): void;
}

/**
 * Waits until the encoder's queue is at most `limit`. A failed or closed encoder emits no more
 * "dequeue" events, so this also wakes on the failure, on abort and every `recheckMs`.
 */
export async function waitForEncodeQueue(enc: QueueingEncoder, limit: number, failure: Failure, signal: AbortSignal, recheckMs = 250): Promise<void> {
  while (enc.encodeQueueSize > limit) {
    failure.throwIfSet();
    if (signal.aborted) throw abortError();
    if (enc.state === 'closed') throw new Error(t("Kodlayıcı beklenmedik şekilde kapandı."));
    await failure.race(new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        enc.removeEventListener('dequeue', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, recheckMs);
      enc.addEventListener('dequeue', done, { once: true });
      signal.addEventListener('abort', done, { once: true });
    }));
  }
  failure.throwIfSet();
}

// ─── Route 2: Windows' Media Foundation encoders through the helper ────────────

/**
 * Renders like the WebCodecs path, but hands NV12 frames and 16-bit PCM to main, which pipes
 * them to the Windows helper (main/mf-export.ts); the helper's Sink Writer encodes H.264 + AAC
 * with Windows' own software encoders and writes the MP4. Sound is sent in step with the
 * pictures so the Sink Writer never has to hold much of either.
 */
async function runMfExport(
  project: Project,
  cursors: Record<ID, PreparedCursor | undefined>,
  mediaBase: string,
  o: ExportOptions,
  begin: { exportId: string; path: string },
  size: { width: number; height: number; total: number },
  report: (patch: Partial<ExportProgress>) => void,
  signal: AbortSignal,
): Promise<void> {
  const { width, height, total } = size;
  const fps = { num: o.fps, den: 1 };
  const media = new ExportMedia(mediaBase, signal);
  const comps = new CompositorHolder(() => newCanvasCompositor());
  const id = begin.exportId;
  try {
    let pcm: [Float32Array, Float32Array] | null = null;
    if (o.includeAudio) {
      report({ phase: 'audio' });
      pcm = await mixTimelineAudio(project, mediaBase, signal);
    }
    report({ phase: 'video' });
    const rgba = new Uint8Array(width * height * 4);
    const nv12 = new Uint8Array(nv12Size(width, height));
    let audioAt = 0;
    const block = 4800;
    const sendAudioUntil = async (seconds: number) => {
      while (pcm && audioAt < pcm[0].length && audioAt / SAMPLE_RATE < seconds) {
        if (signal.aborted) throw abortError();
        const n = Math.min(block, pcm[0].length - audioAt);
        await api.exportMfWrite(id, 'audio', Math.round((audioAt * HNS) / SAMPLE_RATE), Math.round((n * HNS) / SAMPLE_RATE), toPcm16Stereo(pcm[0], pcm[1], audioAt, n));
        audioAt += n;
      }
    };
    const t0 = performance.now();
    for (let n = 0; n < total; n++) {
      if (signal.aborted) throw abortError();
      const p0 = performance.now();
      const plan = evaluate(project, frameToTicks(n, fps), { variantId: o.variantId, cursors, size: { width, height } });
      const rec = plan.recordingId ? project.recordings[plan.recordingId] : undefined;
      const [screen, camera] = await Promise.all([
        rec?.sources.screen && plan.screen ? media.frameAt(rec.sources.screen.file, plan.screen.mediaTime / TICKS_PER_SECOND) : null,
        rec?.sources.camera && plan.camera ? media.frameAt(rec.sources.camera.file, plan.camera.mediaTime / TICKS_PER_SECOND) : null,
      ]);
      const p1 = performance.now();
      const frame = comps.draw((comp) => {
        comp.render(plan, {
          screen, screenSize: screen ? { width: screen.videoWidth, height: screen.videoHeight } : undefined,
          camera, cameraSize: camera ? { width: camera.videoWidth, height: camera.videoHeight } : undefined,
        });
        return new VideoFrame(comp.canvas, { timestamp: Math.round((n * 1e6) / o.fps) });
      }, (f) => f.close());
      try {
        await frame.copyTo(rgba, { format: 'RGBA', colorSpace: 'srgb' } as VideoFrameCopyToOptions);
      } finally {
        frame.close();
      }
      rgbaToNv12(rgba, width, height, nv12);
      const p2 = performance.now();
      await sendAudioUntil((n + 1) / o.fps);
      await api.exportMfWrite(id, 'video', Math.round((n * HNS) / o.fps), Math.round(HNS / o.fps), nv12);
      if (probe.on) {
        const p3 = performance.now();
        probe.record('export-source', p1 - p0);
        probe.record('export-draw', p2 - p1);
        probe.record('export-encode-wait', p3 - p2);
        probe.record('export-frame', p3 - p0);
      }
      if (n % 5 === 0 || n === total - 1) {
        const rate = (n + 1) / Math.max(0.001, (performance.now() - t0) / 1000);
        report({ frame: n + 1, rate, etaSeconds: (total - n - 1) / Math.max(rate, 0.001) });
      }
    }
    await sendAudioUntil(Infinity);
    report({ phase: 'finishing' });
    const end = await api.exportEnd(id);
    report({ phase: 'done', path: end?.path, bytes: end?.bytes, written: 'mp4' });
  } catch (e) {
    await api.exportEnd(id, true).catch(() => undefined);
    const aborted = signal.aborted || isAbort(e);
    report({ phase: aborted ? 'cancelled' : 'error', message: aborted ? undefined : (e as Error).message });
  } finally {
    comps.dispose();
    media.dispose();
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runExport(
  project: Project,
  cursors: Record<ID, PreparedCursor | undefined>,
  mediaBase: string,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportProgress> {
  const { width, height } = outputSize(project, options);
  const fps = { num: options.fps, den: 1 };
  const total = frameCount(sequenceDuration(project), fps);
  const frameUs = 1e6 / options.fps;
  const progress: ExportProgress = { phase: 'preparing', frame: 0, total, rate: 0, etaSeconds: 0 };
  const report = (patch: Partial<ExportProgress>) => { Object.assign(progress, patch); onProgress({ ...progress }); };

  // Route 2 (Windows, Media Foundation). If the helper cannot even start its encoders, nothing
  // was written yet: the export goes on as WebM (route 3) and says so.
  let route: ExportRoute = options.route ?? { kind: 'webcodecs' };
  let target = options.target;
  if (route.kind === 'mf') {
    target ??= await api.exportDefaultTarget(project.id, exportBaseName(project, options.variantId), 'mp4');
    report({ encoder: `${t("H.264 · Windows yazılım kodlayıcısı (daha yavaş)")}${options.includeAudio ? ' + AAC' : ''}`, written: 'mp4' });
    let begin: { exportId: string; path: string };
    try {
      begin = await api.exportMfBegin(target.token, { width, height, fps: options.fps, bitrate: bitrateFor(width, height, options.fps, options.quality, 1), audio: options.includeAudio });
    } catch (e) {
      route = { kind: 'webm-fallback', reason: 'no-h264' };
      target = await api.exportDefaultTarget(project.id, target.name.replace(/\.[^.]+$/, ''), 'webm');
      report({ fallback: `${fallbackNotice(route)} (${(e as Error).message})` });
      begin = null as never;
    }
    if (route.kind === 'mf') {
      await runMfExport(project, cursors, mediaBase, options, begin, { width, height, total }, report, signal);
      return progress;
    }
  }
  const o: ExportOptions = { ...options, format: writtenFormat(options.format, route), target };
  if (route.kind === 'webm-fallback') report({ written: 'webm', fallback: progress.fallback ?? fallbackNotice(route) });

  const bitrate = bitrateFor(width, height, o.fps, o.quality, planFor(o.format).video[0]?.bitrateScale ?? 1);
  const { config: vConfig, label } = await pickVideoConfig(o.format, width, height, o.fps, bitrate);
  const aConfig = o.includeAudio ? await pickAudioConfig(o.format) : null;
  // Never a silent file, and never Opus in an MP4: no encoder for the format's audio is an error.
  if (o.includeAudio && !aConfig) throw noAudioEncoder(o.format);
  report({ encoder: `${label}${aConfig ? ` + ${aConfig.codec === 'opus' ? 'Opus' : 'AAC'}` : ''}` });

  const dest = o.target ?? await api.exportDefaultTarget(project.id, exportBaseName(project, o.variantId), o.format);
  const begin = await api.exportBegin(dest.token);
  const { sink, flush } = bufferedSink(begin.exportId);
  const failure = new Failure();
  const media = new ExportMedia(mediaBase, signal);
  const comps = new CompositorHolder(() => newCanvasCompositor());

  const vp9 = vConfig.codec.startsWith('vp09');
  // Config objects are shared with the writer; descriptions are filled in when the encoders emit them.
  const videoCfg: Mp4VideoConfig | { codec: 'V_VP8' | 'V_VP9'; width: number; height: number } = o.format === 'mp4'
    ? (vp9 ? { codec: 'vp09', width, height, codecString: vConfig.codec } : { codec: 'avc1', width, height, description: undefined })
    : { codec: vConfig.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width, height };
  const audioCfg = aConfig ? { codec: (aConfig.codec === 'opus' ? 'opus' : 'mp4a') as 'mp4a' | 'opus', sampleRate: SAMPLE_RATE, channels: 2, description: undefined as Uint8Array | undefined } : undefined;
  const mp4 = o.format === 'mp4' ? new Mp4Writer({
    video: videoCfg as Mp4VideoConfig,
    audio: audioCfg,
    sink,
  }) : null;
  const webm = o.format === 'webm' ? new WebmWriter({
    video: videoCfg as { codec: 'V_VP9' | 'V_VP8'; width: number; height: number },
    audio: aConfig ? { codec: 'A_OPUS', sampleRate: SAMPLE_RATE, channels: 2 } : undefined,
    sink,
  }) : null;

  // Closed in `finally` so an export that stops early does not leave a codec running.
  const encoders: { readonly state: string; close(): void }[] = [];
  let writeChain = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => { writeChain = writeChain.then(fn).catch((e) => { failure.set(e); }); };

  try {
    // 1) Audio first: it is queued in the muxer and interleaved with video by time.
    if (aConfig) {
      report({ phase: 'audio' });
      const pcm = await mixTimelineAudio(project, mediaBase, signal);
      if (pcm) {
        const audioDesc: { value?: Uint8Array } = {};
        const enc = new AudioEncoder({
          output: (chunk, meta) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            if (meta?.decoderConfig?.description && !audioDesc.value) {
              audioDesc.value = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
              if (audioCfg) audioCfg.description = audioDesc.value;
            }
            const ts = chunk.timestamp;
            const dur = chunk.duration ?? 21_333;
            enqueue(async () => { if (mp4) await mp4.addAudio(data, ts, dur); else await webm!.addAudio(data, ts); });
          },
          error: (e) => { failure.set(e); },
        });
        encoders.push(enc);
        enc.configure(aConfig);
        const [L, R] = pcm;
        const block = 4800;
        for (let i = 0; i < L.length; i += block) {
          failure.throwIfSet();
          const n = Math.min(block, L.length - i);
          const planar = new Float32Array(n * 2);
          planar.set(L.subarray(i, i + n), 0);
          planar.set(R.subarray(i, i + n), n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / SAMPLE_RATE) * 1e6), data: planar });
          enc.encode(ad);
          ad.close();
          if (signal.aborted) throw abortError();
          // Same back-pressure as video: a failed encoder must not leave the export waiting.
          if (enc.encodeQueueSize > 32) await waitForEncodeQueue(enc, 32, failure, signal);
        }
        await failure.race(enc.flush());
        enc.close();
      }
    }

    // 2) Video: render every output frame with the shared compositor and encode it.
    report({ phase: 'video' });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (meta?.decoderConfig?.description && o.format === 'mp4' && !vp9 && !(videoCfg as Mp4VideoConfig).description) {
          (videoCfg as Mp4VideoConfig).description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
        }
        const ts = chunk.timestamp;
        const key = chunk.type === 'key';
        enqueue(async () => { if (mp4) await mp4.addVideo(data, ts, chunk.duration ?? frameUs, key); else await webm!.addVideo(data, ts, key); });
      },
      error: (e) => { failure.set(e); },
    });
    encoders.push(encoder);
    encoder.configure(vConfig);
    const t0 = performance.now();
    const gop = o.fps * 2;
    for (let n = 0; n < total; n++) {
      if (signal.aborted) throw abortError();
      failure.throwIfSet();
      const p0 = performance.now();
      const at = frameToTicks(n, fps);
      const plan = evaluate(project, at, { variantId: o.variantId, cursors, size: { width, height } });
      const rec = plan.recordingId ? project.recordings[plan.recordingId] : undefined;
      const [screen, camera] = await Promise.all([
        rec?.sources.screen && plan.screen ? media.frameAt(rec.sources.screen.file, plan.screen.mediaTime / TICKS_PER_SECOND) : null,
        rec?.sources.camera && plan.camera ? media.frameAt(rec.sources.camera.file, plan.camera.mediaTime / TICKS_PER_SECOND) : null,
      ]);
      const p1 = performance.now();
      // Drawn again on a new compositor if the context is lost before the frame is taken.
      const frame = comps.draw((comp) => {
        comp.render(plan, {
          screen, screenSize: screen ? { width: screen.videoWidth, height: screen.videoHeight } : undefined,
          camera, cameraSize: camera ? { width: camera.videoWidth, height: camera.videoHeight } : undefined,
        });
        return new VideoFrame(comp.canvas, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs) });
      }, (f) => f.close());
      try {
        encoder.encode(frame, { keyFrame: n % gop === 0 });
      } finally {
        frame.close();
      }
      const p2 = performance.now();
      if (encoder.encodeQueueSize > 6) await waitForEncodeQueue(encoder, 6, failure, signal);
      if (probe.on) {
        const p3 = performance.now();
        probe.record('export-source', p1 - p0);
        probe.record('export-draw', p2 - p1);
        probe.record('export-encode-wait', p3 - p2);
        probe.record('export-frame', p3 - p0);
      }
      if (n % 5 === 0 || n === total - 1) {
        const elapsed = (performance.now() - t0) / 1000;
        const rate = (n + 1) / Math.max(0.001, elapsed);
        report({ frame: n + 1, rate, etaSeconds: (total - n - 1) / Math.max(rate, 0.001) });
      }
    }
    await failure.race(encoder.flush());
    encoder.close();
    await failure.race(writeChain);
    failure.throwIfSet();

    report({ phase: 'finishing' });
    if (mp4) await mp4.finish();
    else await webm!.finish(Math.round(frameUs / 1000));
    await flush();
    const end = await api.exportEnd(begin.exportId);
    report({ phase: 'done', path: end?.path, bytes: end?.bytes, written: o.format });
  } catch (e) {
    // A closed encoder throws a generic InvalidStateError on encode(); report the cause instead.
    const err = (failure.error ?? e) as Error;
    await flush().catch(() => undefined);
    await api.exportEnd(begin.exportId, true).catch(() => undefined);
    const aborted = signal.aborted || (!failure.error && isAbort(e));
    report({ phase: aborted ? 'cancelled' : 'error', message: aborted ? undefined : err.message });
  } finally {
    for (const enc of encoders) if (enc.state !== 'closed') { try { enc.close(); } catch { /* already closed */ } }
    comps.dispose();
    media.dispose();
  }
  return progress;
}
