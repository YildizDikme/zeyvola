/**
 * Synthetic recording for end-to-end tests: a made-up settings screen, an abstract camera
 * feed and a tone track, encoded with WebCodecs into our own MP4 files, plus a scripted
 * cursor/click log. No real screen, camera or person is involved.
 */
import { Mp4Writer, WebmWriter, type Mp4VideoConfig } from '@zeyvola/media-web';
import { PATENT_POOL_CODECS, PROFILE } from '../shared/distribution';
import { msToTicks } from '@zeyvola/timing';

export interface SyntheticRecording {
  screen: Uint8Array;
  camera: Uint8Array;
  /** Container of screen and camera: MP4, or WebM in the VP8 distribution (like its recorder). */
  videoMime: 'video/mp4' | 'video/webm';
  mic: Uint8Array;
  /** Container of the voice track; MP4 (Opus) when absent. */
  micMime?: 'audio/mp4' | 'audio/webm';
  /** Frame rate of the screen video; 30 when absent. */
  screenFps?: number;
  /** Recorder the files imitate; the macOS helper when absent. */
  backend?: 'native-macos' | 'web';
  cursorLog: string;
  durationMs: number;
  screenSize: { width: number; height: number };
  cameraSize: { width: number; height: number };
  /** Where the fake phone number is drawn, normalized. */
  secretRegion: { x: number; y: number; w: number; h: number };
}

const FIXTURE_MIME: 'video/mp4' | 'video/webm' = PROFILE.formats.includes('mp4') ? 'video/mp4' : 'video/webm';
const W = 1440;
const H = 900;
const FPS = 30;

interface Target { t: number; x: number; y: number }
const TARGETS: Target[] = [
  { t: 1.6, x: 0.785, y: 0.79 },
  { t: 3.4, x: 0.47, y: 0.405 },
  { t: 4.4, x: 0.47, y: 0.52 },
  { t: 6.6, x: 0.095, y: 0.335 },
];

function cursorAt(t: number): { x: number; y: number } {
  let from = { t: 0, x: 0.55, y: 0.6 };
  for (const g of TARGETS) {
    const travel = 0.7;
    if (t < g.t - travel) return { x: from.x, y: from.y };
    if (t < g.t) {
      const u = (t - (g.t - travel)) / travel;
      const e = u * u * (3 - 2 * u);
      return { x: from.x + (g.x - from.x) * e, y: from.y + (g.y - from.y) * e };
    }
    from = g;
  }
  return { x: from.x, y: from.y };
}

function drawScreen(g: CanvasRenderingContext2D, t: number): void {
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, W, H);
  // Sidebar
  g.fillStyle = '#1d2027';
  g.fillRect(0, 0, 250, H);
  g.fillStyle = '#e8e4dc';
  g.font = '600 22px -apple-system, system-ui, sans-serif';
  g.fillText('Örnek Uygulama', 28, 52);
  const items = ['Genel bakış', 'Hesap', 'Bildirimler', 'Faturalar', 'Ekip', 'Entegrasyonlar'];
  items.forEach((label, i) => {
    const y = 110 + i * 46;
    const active = (t >= 6.6 && i === 4) || (t < 6.6 && i === 1);
    if (active) { g.fillStyle = '#343a46'; g.beginPath(); g.roundRect(14, y - 26, 222, 38, 9); g.fill(); }
    g.fillStyle = active ? '#ffffff' : '#a9adb8';
    g.font = '500 17px -apple-system, system-ui, sans-serif';
    g.fillText(label, 34, y);
  });
  // Header
  g.fillStyle = '#16181d';
  g.font = '650 34px -apple-system, system-ui, sans-serif';
  g.fillText(t >= 6.6 ? 'Ekip' : 'Hesap ayarları', 300, 86);
  g.fillStyle = '#6c6f78';
  g.font = '400 17px -apple-system, system-ui, sans-serif';
  g.fillText('Profil bilgilerinizi ve iletişim tercihlerinizi yönetin.', 300, 118);
  // Card
  g.fillStyle = '#ffffff';
  g.beginPath(); g.roundRect(300, 160, 1080, 560, 18); g.fill();
  g.strokeStyle = '#e4e0d8'; g.lineWidth = 1.5; g.stroke();
  const fields: [string, string][] = [['Ad soyad', 'Deniz Örnek'], ['Telefon', '0555 123 45 67'], ['E-posta', 'deniz@ornek.test']];
  fields.forEach(([label, value], i) => {
    const y = 230 + i * 104;
    g.fillStyle = '#6c6f78'; g.font = '500 15px -apple-system, system-ui, sans-serif'; g.fillText(label, 340, y);
    const focused = (i === 1 && t >= 3.4 && t < 4.4) || (i === 2 && t >= 4.4 && t < 6.2);
    g.fillStyle = '#faf9f6'; g.beginPath(); g.roundRect(340, y + 14, 680, 54, 10); g.fill();
    g.strokeStyle = focused ? '#c8862a' : '#dcd7cc'; g.lineWidth = focused ? 2.5 : 1.5; g.stroke();
    g.fillStyle = '#16181d'; g.font = '500 21px -apple-system, system-ui, sans-serif'; g.fillText(value, 362, y + 50);
  });
  // Toggle row
  g.fillStyle = '#16181d'; g.font = '500 18px -apple-system, system-ui, sans-serif'; g.fillText('Haftalık özet e-postası', 340, 590);
  g.fillStyle = '#c8862a'; g.beginPath(); g.roundRect(960, 568, 60, 32, 16); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(1004, 584, 12, 0, Math.PI * 2); g.fill();
  // Save button (pressed state after the click at 1.6 s)
  const pressed = t >= 1.6 && t < 2.1;
  const saved = t >= 2.1 && t < 3.0;
  g.fillStyle = pressed ? '#a8701f' : '#c8862a';
  g.beginPath(); g.roundRect(1060, 690, 240, 60, 14); g.fill();
  g.fillStyle = '#1a1406'; g.font = '650 20px -apple-system, system-ui, sans-serif';
  g.fillText(saved ? 'Kaydedildi ✓' : 'Değişiklikleri kaydet', saved ? 1112 : 1080, 728);
  // Subtle live element so frames differ.
  g.fillStyle = '#9a9ca3'; g.font = '400 14px ui-monospace, monospace';
  g.fillText(`son eşitleme ${(t * 1000).toFixed(0).padStart(5, '0')} ms`, 300, 860);
}

function drawCamera(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#3a4a5e');
  grad.addColorStop(1, '#1f2733');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const bob = Math.sin(t * 2.2) * 6;
  g.fillStyle = '#c9a78a';
  g.beginPath(); g.ellipse(w / 2, h * 0.44 + bob, h * 0.17, h * 0.21, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2d3a4c';
  g.beginPath(); g.ellipse(w / 2, h * 1.02 + bob, h * 0.42, h * 0.3, 0, Math.PI, 0); g.fill();
  g.fillStyle = '#3b3027';
  g.beginPath(); g.ellipse(w / 2, h * 0.3 + bob, h * 0.18, h * 0.09, 0, Math.PI, 0); g.fill();
}

async function encodeVideo(width: number, height: number, frames: number, draw: (g: CanvasRenderingContext2D, t: number) => void): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const parts: { d: Uint8Array; p: number | null }[] = [];
  // Like the recorders: the macOS helper writes H.264 with the OS (hardware) encoder, so the A and
  // B builds (both with H.264 through the OS) use H.264 in MP4; the VP8 build, which has no H.264
  // at all, records VP8 in WebM (Chromium's recorder).
  const vp8 = FIXTURE_MIME === 'video/webm';
  const codec = PATENT_POOL_CODECS ? 'avc1.640028' : vp8 ? 'vp8' : 'vp09.00.41.08';
  const video: Mp4VideoConfig = PATENT_POOL_CODECS ? { codec: 'avc1', width, height } : { codec: 'vp09', width, height, codecString: codec };
  const sink = async (d: Uint8Array, p: number | null) => { parts.push({ d: d.slice(), p }); };
  const w = vp8 ? new WebmWriter({ video: { codec: 'V_VP8', width, height }, sink }) : new Mp4Writer({ video, sink });
  let chain = Promise.resolve();
  const enc = new VideoEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength);
      c.copyTo(d);
      if (meta?.decoderConfig?.description && PATENT_POOL_CODECS) video.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp;
      const key = c.type === 'key';
      chain = chain.then(() => (w instanceof WebmWriter ? w.addVideo(d, ts, key) : w.addVideo(d, ts, 1e6 / FPS, key)));
    },
    error: (e) => { throw e; },
  });
  enc.configure(PATENT_POOL_CODECS
    ? { codec, width, height, bitrate: 8e6, framerate: FPS, avc: { format: 'avc' }, hardwareAcceleration: 'prefer-hardware' }
    : { codec, width, height, bitrate: 8e6, framerate: FPS });
  for (let i = 0; i < frames; i++) {
    draw(g, i / FPS);
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % FPS === 0 });
    f.close();
  }
  await enc.flush();
  enc.close();
  await chain;
  await (w instanceof WebmWriter ? w.finish(1000 / FPS) : w.finish());
  return assemble(parts);
}

async function encodeTone(seconds: number): Promise<Uint8Array> {
  const parts: { d: Uint8Array; p: number | null }[] = [];
  // Opus in MP4, like the macOS recorder's mic.m4a / system.m4a.
  const audio: { codec: 'opus'; sampleRate: number; channels: number; description?: Uint8Array } = { codec: 'opus', sampleRate: 48000, channels: 1 };
  const w = new Mp4Writer({ audio, sink: async (d, p) => { parts.push({ d: d.slice(), p }); } });
  let chain = Promise.resolve();
  const enc = new AudioEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength);
      c.copyTo(d);
      if (meta?.decoderConfig?.description) audio.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp;
      const dur = c.duration ?? 20000;
      chain = chain.then(() => w.addAudio(d, ts, dur));
    },
    error: (e) => { throw e; },
  });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 });
  const n = Math.round(seconds * 48000);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    const syllable = Math.max(0, Math.sin(t * Math.PI * 3.1)) ** 2;
    pcm[i] = (Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 360 * t) * 0.25) * syllable * 0.25;
  }
  enc.encode(new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 1, timestamp: 0, data: pcm }));
  await enc.flush();
  enc.close();
  await chain;
  await w.finish();
  return assemble(parts);
}

function assemble(parts: { d: Uint8Array; p: number | null }[]): Uint8Array {
  let size = 0;
  let pos = 0;
  for (const x of parts) { const at = x.p ?? pos; size = Math.max(size, at + x.d.length); if (x.p === null) pos += x.d.length; }
  const out = new Uint8Array(size);
  pos = 0;
  for (const x of parts) { const at = x.p ?? pos; out.set(x.d, at); if (x.p === null) pos += x.d.length; }
  return out;
}

/** The scripted pointer: 60 Hz positions and a click on each target, in the recorders' JSONL format. */
function cursorLogFor(seconds: number): string {
  const lines: string[] = [];
  for (let i = 0; i <= seconds * 60; i++) {
    const t = i / 60;
    const p = cursorAt(t);
    lines.push(JSON.stringify({ e: 'm', t: msToTicks(t * 1000), x: +p.x.toFixed(5), y: +p.y.toFixed(5) }));
  }
  for (const g of TARGETS) {
    if (g.t > seconds) continue;
    lines.push(JSON.stringify({ e: 'd', t: msToTicks(g.t * 1000), x: g.x, y: g.y, b: 'l' }));
    lines.push(JSON.stringify({ e: 'u', t: msToTicks(g.t * 1000 + 90), x: g.x, y: g.y, b: 'l' }));
  }
  return `${lines.join('\n')}\n`;
}

export async function synthesizeRecording(seconds = 8): Promise<SyntheticRecording> {
  const frames = Math.round(seconds * FPS);
  const [screen, camera, mic] = await Promise.all([
    encodeVideo(W, H, frames, drawScreen),
    encodeVideo(1280, 720, frames, (g, t) => drawCamera(g, 1280, 720, t)),
    encodeTone(seconds),
  ]);
  return {
    screen, camera, videoMime: FIXTURE_MIME, mic, cursorLog: cursorLogFor(seconds), durationMs: seconds * 1000,
    screenSize: { width: W, height: H }, cameraSize: { width: 1280, height: 720 },
    secretRegion: { x: 336 / W, y: 344 / H, w: 688 / W, h: 62 / H },
  };
}

/**
 * The same made-up content recorded the way the Chromium recording path does it
 * (renderer/capture.ts): MediaRecorder writing WebM in real time. Such files have no duration
 * and no seek index, and the screen track only gets a frame when the picture changes, so long
 * still stretches have very few frames. Playback and export must cope with exactly that.
 * Takes `seconds` of real time.
 */
export async function recordLikeBrowser(seconds = 8): Promise<SyntheticRecording> {
  const SW = 1920;
  const SH = 1080;
  const CW = 640;
  const CH = 480;
  const screen = document.createElement('canvas');
  screen.width = SW;
  screen.height = SH;
  const sg = screen.getContext('2d')!;
  sg.scale(SW / W, SH / H);
  const cam = document.createElement('canvas');
  cam.width = CW;
  cam.height = CH;
  const cg = cam.getContext('2d')!;
  drawScreen(sg, 0);
  drawCamera(cg, CW, CH, 0);

  const audio = new AudioContext({ sampleRate: 48000 });
  const osc = audio.createOscillator();
  osc.frequency.value = 220;
  const gain = audio.createGain();
  gain.gain.value = 0.12;
  const dest = audio.createMediaStreamDestination();
  osc.connect(gain).connect(dest);

  const videoMime = PROFILE.recorderVideo.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
  const audioMime = PROFILE.recorderAudio.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'audio/webm';
  const record = (stream: MediaStream, mimeType: string, bits: number, video: boolean) => {
    const opts: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number } = video
      ? { mimeType, videoBitsPerSecond: bits, videoKeyFrameIntervalDuration: 1000 }
      : { mimeType, audioBitsPerSecond: bits };
    const r = new MediaRecorder(stream, opts);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise<Uint8Array>((res) => { r.onstop = async () => res(new Uint8Array(await new Blob(chunks).arrayBuffer())); });
    r.start(1000);
    return { stop: () => { r.stop(); for (const t of stream.getTracks()) t.stop(); return done; } };
  };
  const recorders = [
    record(screen.captureStream(60), videoMime, 8e6, true),
    record(cam.captureStream(30), videoMime, 2e6, true),
    record(dest.stream, audioMime, 96_000, false),
  ];
  osc.start();

  // The screen is redrawn only when something on it changes: at each click and a few times a
  // second in between. The camera moves all the time, like a real one.
  const t0 = performance.now();
  let lastStep = -1;
  await new Promise<void>((done) => {
    const timer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) { clearInterval(timer); done(); return; }
      drawCamera(cg, CW, CH, t);
      const step = Math.floor(t / 0.4) + TARGETS.filter((g) => g.t <= t).length * 1000;
      if (step !== lastStep) { lastStep = step; drawScreen(sg, t); }
    }, 1000 / 30);
  });
  const durationMs = performance.now() - t0;
  const [screenFile, cameraFile, mic] = await Promise.all(recorders.map((r) => r.stop()));
  osc.stop();
  await audio.close();
  return {
    screen: screenFile!, camera: cameraFile!, videoMime: 'video/webm', mic: mic!, micMime: 'audio/webm', screenFps: 60, backend: 'web',
    cursorLog: cursorLogFor(durationMs / 1000), durationMs,
    screenSize: { width: SW, height: SH }, cameraSize: { width: CW, height: CH },
    secretRegion: { x: 336 / W, y: 344 / H, w: 688 / W, h: 62 / H },
  };
}
