/**
 * Hidden capture window for the browser-based fallback backend. Each source gets its own
 * MediaRecorder and its own file; chunks stream to the main process every second so a
 * crash loses at most the last second.
 */
import type { CaptureConfig } from '@zeyvola/protocol';
import { acquire, warmUpCamera } from './capture-devices';
import { initI18n, t } from './i18n';
import { PROFILE } from '../shared/distribution';
import { FrameWatch } from './frame-watch';

interface StartMessage {
  config: CaptureConfig;
  pixelWidth: number;
  pixelHeight: number;
  systemAudio: boolean;
}

type Kind = 'screen' | 'camera' | 'mic' | 'system';

interface Active {
  kind: Kind;
  recorder: MediaRecorder;
  handle: string;
  done: Promise<void>;
  stream: MediaStream;
  /** Times the recorder's first frame (FrameWatch); started before the recorder. */
  watch: FrameWatch;
}

const bridge = window.zeyvola;
void initI18n();
const now = () => performance.timeOrigin + performance.now();
let active: Active[] = [];
let levelTimer = 0;
let audioCtx: AudioContext | null = null;

// Royalty-free formats only (both distributions): Chromium's MediaRecorder may encode H.264
// with the bundled OpenH264 when no hardware encoder is free, which neither profile allows.
function pickMime(kind: Kind): string {
  const list = kind === 'screen' || kind === 'camera' ? PROFILE.recorderVideo : PROFILE.recorderAudio;
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function bitrate(kind: Kind, quality: CaptureConfig['quality'], pixels: number): number {
  if (kind === 'mic' || kind === 'system') return 160_000;
  if (kind === 'camera') return quality === 'max' ? 10e6 : quality === 'high' ? 7e6 : 4e6;
  const base = pixels > 6e6 ? 30e6 : pixels > 3e6 ? 20e6 : 12e6;
  return quality === 'max' ? base * 1.5 : quality === 'high' ? base : base * 0.6;
}

async function record(kind: Kind, stream: MediaStream, watch: FrameWatch, config: CaptureConfig, pixels: number): Promise<Active> {
  const mime = pickMime(kind);
  const handle = (await bridge.invoke('cw:open', { kind, mime: mime || 'video/webm' })) as string;
  const opts: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = {
    mimeType: mime || undefined,
    ...(kind === 'screen' || kind === 'camera'
      ? { videoBitsPerSecond: bitrate(kind, config.quality, pixels), videoKeyFrameIntervalDuration: 1000 }
      : { audioBitsPerSecond: bitrate(kind, config.quality, pixels) }),
  };
  const recorder = new MediaRecorder(stream, opts);
  const a: Active = { kind, recorder, handle, stream, watch, done: Promise.resolve() };
  let chain = Promise.resolve();
  const meta = () => {
    const track = stream.getVideoTracks()[0] ?? stream.getAudioTracks()[0];
    const s = track?.getSettings() ?? {};
    return {
      firstFrameMs: watch.firstFrameMs(),
      width: s.width ? Math.round(s.width) : undefined, height: s.height ? Math.round(s.height) : undefined,
      fps: s.frameRate ? Math.round(s.frameRate) : undefined,
      sampleRate: s.sampleRate ? Math.round(s.sampleRate) : undefined,
      channels: s.channelCount ? Math.round(s.channelCount) : undefined,
    };
  };
  let sentFirst = false;
  recorder.addEventListener('dataavailable', (e) => {
    if (!e.data || e.data.size === 0) return;
    const blob = e.data;
    chain = chain.then(async () => {
      const data = new Uint8Array(await blob.arrayBuffer());
      const first = sentFirst ? undefined : meta();
      sentFirst = true;
      await bridge.invoke('cw:chunk', { handle, data, ...(first ? { first } : {}) });
    });
  });
  a.done = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => {
      chain = chain.then(async () => {
        await bridge.invoke('cw:close', { handle, ...meta() });
      }).finally(resolve);
    });
  });
  return a;
}

const onBusy = (device: 'camera' | 'mic') => bridge.invoke('cw:busy', { device }).then(() => undefined);
let prepared: { items: [Kind, MediaStream][]; config: CaptureConfig; pixels: number; watches: FrameWatch[] } | null = null;

// Prepare: open every source and warm up the camera, but do not record yet.
bridge.on('cw:prepare', async (raw) => {
  const msg = raw as StartMessage;
  const { config } = msg;
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: msg.pixelWidth }, height: { ideal: msg.pixelHeight }, frameRate: { ideal: config.fps, max: config.fps } },
      audio: msg.systemAudio,
    });
    const items: [Kind, MediaStream][] = [['screen', new MediaStream(screenStream.getVideoTracks())]];
    const sys = screenStream.getAudioTracks();
    if (sys.length) items.push(['system', new MediaStream(sys)]);
    let cameraWarmupMs: number | null = null;
    if (config.cameraDeviceId) {
      const cam = await acquire('camera', onBusy, {
        video: { deviceId: { exact: config.cameraDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
      cameraWarmupMs = await warmUpCamera(cam);
      items.push(['camera', cam]);
    }
    if (config.micDeviceId) {
      const mic = await acquire('mic', onBusy, {
        audio: { deviceId: { exact: config.micDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      items.push(['mic', mic]);
      audioCtx = new AudioContext();
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      audioCtx.createMediaStreamSource(mic).connect(an);
      const buf = new Float32Array(an.fftSize);
      levelTimer = window.setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        void bridge.invoke('cw:level', { mic: Math.min(1, Math.sqrt(sum / buf.length) * 4) });
      }, 120);
    }
    // Each track is watched from now on, so its first recorded frame can be timed at the start.
    const watches = items.map(([, st]) => new FrameWatch((st.getVideoTracks()[0] ?? st.getAudioTracks()[0])!));
    prepared = { items, config, pixels: msg.pixelWidth * msg.pixelHeight, watches };
    await bridge.invoke('cw:ready', { cameraWarmupMs });
  } catch (e) {
    await bridge.invoke('cw:failed', { message: t("Kayıt hazırlanamadı: {msg}", { msg: (e as Error).message }) });
  }
});

// Go: all recorders start together on already-running, warmed-up streams.
bridge.on('cw:go', async () => {
  try {
    if (!prepared) throw new Error(t("Kaynaklar hazır değil"));
    const p = prepared;
    active = await Promise.all(p.items.map(([k, s], i) => record(k, s, p.watches[i]!, p.config, p.pixels)));
    const startedAt = now();
    for (const a of active) {
      a.watch.started(now());
      a.recorder.start(1000);
    }
    await bridge.invoke('cw:started', { startedAtMs: startedAt, kinds: active.map((a) => a.kind) });
  } catch (e) {
    await bridge.invoke('cw:failed', { message: t("Kayıt başlatılamadı: {msg}", { msg: (e as Error).message }) });
  }
});

bridge.on('cw:pause', () => { for (const a of active) if (a.recorder.state === 'recording') a.recorder.pause(); });
bridge.on('cw:resume', () => { for (const a of active) if (a.recorder.state === 'paused') a.recorder.resume(); });
bridge.on('cw:stop', async () => {
  window.clearInterval(levelTimer);
  for (const a of active) if (a.recorder.state !== 'inactive') a.recorder.stop();
  await Promise.all(active.map((a) => a.done));
  for (const a of active) for (const t of a.stream.getTracks()) t.stop();
  for (const [, st] of prepared?.items ?? []) for (const t of st.getTracks()) t.stop();
  for (const w of prepared?.watches ?? []) w.close();
  prepared = null;
  await audioCtx?.close();
  active = [];
});
