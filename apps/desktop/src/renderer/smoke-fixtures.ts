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

/** Language of the made-up screen's text. Turkish for the tests; English for the README pictures. */
export type FixtureLang = 'tr' | 'en';

/** Every word drawn on the made-up screen. The layout is the same in both languages. */
const TEXT: Record<FixtureLang, {
  app: string; menu: string[]; title: string; teamTitle: string; subtitle: string;
  fields: [string, string][]; toggle: string; save: string; saved: string; sync: string;
}> = {
  tr: {
    app: 'Örnek Uygulama', menu: ['Genel bakış', 'Hesap', 'Bildirimler', 'Faturalar', 'Ekip', 'Entegrasyonlar'],
    title: 'Hesap ayarları', teamTitle: 'Ekip', subtitle: 'Profil bilgilerinizi ve iletişim tercihlerinizi yönetin.',
    fields: [['Ad soyad', 'Deniz Örnek'], ['Telefon', '0555 123 45 67'], ['E-posta', 'deniz@ornek.test']],
    toggle: 'Haftalık özet e-postası', save: 'Değişiklikleri kaydet', saved: 'Kaydedildi ✓', sync: 'son eşitleme',
  },
  en: {
    app: 'Example App', menu: ['Overview', 'Account', 'Notifications', 'Billing', 'Team', 'Integrations'],
    title: 'Account settings', teamTitle: 'Team', subtitle: 'Manage your profile details and contact preferences.',
    fields: [['Full name', 'Alex Example'], ['Phone', '(555) 010-0123'], ['Email', 'alex@example.test']],
    toggle: 'Weekly summary email', save: 'Save changes', saved: 'Saved ✓', sync: 'last sync',
  },
};

function drawScreen(g: CanvasRenderingContext2D, t: number, lang: FixtureLang = 'tr'): void {
  const tx = TEXT[lang];
  g.fillStyle = '#f4f2ee';
  g.fillRect(0, 0, W, H);
  // Sidebar
  g.fillStyle = '#1d2027';
  g.fillRect(0, 0, 250, H);
  g.fillStyle = '#e8e4dc';
  g.font = '600 22px -apple-system, system-ui, sans-serif';
  g.fillText(tx.app, 28, 52);
  const items = tx.menu;
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
  g.fillText(t >= 6.6 ? tx.teamTitle : tx.title, 300, 86);
  g.fillStyle = '#6c6f78';
  g.font = '400 17px -apple-system, system-ui, sans-serif';
  g.fillText(tx.subtitle, 300, 118);
  // Card
  g.fillStyle = '#ffffff';
  g.beginPath(); g.roundRect(300, 160, 1080, 560, 18); g.fill();
  g.strokeStyle = '#e4e0d8'; g.lineWidth = 1.5; g.stroke();
  const fields = tx.fields;
  fields.forEach(([label, value], i) => {
    const y = 230 + i * 104;
    g.fillStyle = '#6c6f78'; g.font = '500 15px -apple-system, system-ui, sans-serif'; g.fillText(label, 340, y);
    const focused = (i === 1 && t >= 3.4 && t < 4.4) || (i === 2 && t >= 4.4 && t < 6.2);
    g.fillStyle = '#faf9f6'; g.beginPath(); g.roundRect(340, y + 14, 680, 54, 10); g.fill();
    g.strokeStyle = focused ? '#c8862a' : '#dcd7cc'; g.lineWidth = focused ? 2.5 : 1.5; g.stroke();
    g.fillStyle = '#16181d'; g.font = '500 21px -apple-system, system-ui, sans-serif'; g.fillText(value, 362, y + 50);
  });
  // Toggle row
  g.fillStyle = '#16181d'; g.font = '500 18px -apple-system, system-ui, sans-serif'; g.fillText(tx.toggle, 340, 590);
  g.fillStyle = '#c8862a'; g.beginPath(); g.roundRect(960, 568, 60, 32, 16); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(1004, 584, 12, 0, Math.PI * 2); g.fill();
  // Save button (pressed state after the click at 1.6 s)
  const pressed = t >= 1.6 && t < 2.1;
  const saved = t >= 2.1 && t < 3.0;
  g.fillStyle = pressed ? '#a8701f' : '#c8862a';
  g.beginPath(); g.roundRect(1060, 690, 240, 60, 14); g.fill();
  g.fillStyle = '#1a1406'; g.font = '650 20px -apple-system, system-ui, sans-serif';
  g.fillText(saved ? tx.saved : tx.save, saved ? (lang === 'en' ? 1135 : 1112) : (lang === 'en' ? 1115 : 1080), 728);
  // Subtle live element so frames differ.
  g.fillStyle = '#9a9ca3'; g.font = '400 14px ui-monospace, monospace';
  g.fillText(`${tx.sync} ${(t * 1000).toFixed(0).padStart(5, '0')} ms`, 300, 860);
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

/**
 * The README pictures' camera (pnpm docshots only; the tests keep drawCamera above): a made-up
 * cartoon person with glasses on a soft violet backdrop matching the interface palette. Bold,
 * simple shapes so the face still reads in a camera bubble of about 60–130 px. Moves only with
 * `t` (a slow head bob, a blink every few seconds), so every run draws the same frames.
 */
function drawCharacter(g: CanvasRenderingContext2D, w: number, h: number, t: number): void {
  const u = h / 720; // drawn for 720 px of height, scaled to the canvas
  const cx = w / 2;
  // Backdrop: ink-violet to a warm corner, with a soft light behind the head.
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#3a2c63');
  bg.addColorStop(0.55, '#2a2142');
  bg.addColorStop(1, '#4a2a3e');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const glow = g.createRadialGradient(cx - 60 * u, h * 0.36, 20 * u, cx, h * 0.42, h * 0.62);
  glow.addColorStop(0, 'rgba(255, 168, 98, 0.30)');
  glow.addColorStop(0.5, 'rgba(178, 124, 255, 0.16)');
  glow.addColorStop(1, 'rgba(178, 124, 255, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  const bob = Math.sin(t * 1.7) * 5 * u;
  const tilt = Math.sin(t * 0.9) * 0.03;
  const ink = '#2a1d2e';
  const line = 9 * u;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // Shoulders: a rounded sweater with a shirt collar.
  const shoulderY = h * 0.78 + bob * 0.4;
  g.fillStyle = '#ff8f4a';
  g.strokeStyle = ink;
  g.lineWidth = line;
  g.beginPath();
  g.moveTo(cx - 300 * u, h + 20 * u);
  g.bezierCurveTo(cx - 300 * u, shoulderY - 10 * u, cx - 220 * u, shoulderY - 70 * u, cx - 110 * u, shoulderY - 80 * u);
  g.lineTo(cx + 110 * u, shoulderY - 80 * u);
  g.bezierCurveTo(cx + 220 * u, shoulderY - 70 * u, cx + 300 * u, shoulderY - 10 * u, cx + 300 * u, h + 20 * u);
  g.closePath();
  g.fill();
  g.stroke();
  // Neck.
  g.fillStyle = '#e3a882';
  g.beginPath();
  g.roundRect(cx - 48 * u, shoulderY - 150 * u, 96 * u, 90 * u, 30 * u);
  g.fill();
  g.stroke();
  // Collar points.
  g.fillStyle = '#f7f4fb';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx, shoulderY - 62 * u);
    g.lineTo(cx + side * 78 * u, shoulderY - 84 * u);
    g.lineTo(cx + side * 58 * u, shoulderY - 18 * u);
    g.closePath();
    g.fill();
    g.stroke();
  }

  // Head, ears, hair, face: turned slightly with the bob.
  g.save();
  g.translate(cx, h * 0.44 + bob);
  g.rotate(tilt);
  const R = 150 * u; // head radius
  g.fillStyle = '#f2c4a0';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(side * R * 0.98, 12 * u, 26 * u, 36 * u, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  g.beginPath();
  g.ellipse(0, 0, R * 0.95, R * 1.08, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // Hair: a rounded cap with a side sweep over the forehead.
  g.fillStyle = '#4a2f2a';
  g.beginPath();
  g.moveTo(-R * 0.98, 10 * u);
  g.bezierCurveTo(-R * 1.08, -R * 1.05, R * 0.4, -R * 1.45, R * 0.98, -R * 0.35);
  g.bezierCurveTo(R * 1.02, -R * 0.1, R * 0.95, 0, R * 0.9, 6 * u);
  g.bezierCurveTo(R * 0.75, -R * 0.45, R * 0.3, -R * 0.62, -R * 0.12, -R * 0.55);
  g.bezierCurveTo(-R * 0.45, -R * 0.5, -R * 0.7, -R * 0.3, -R * 0.98, 10 * u);
  g.closePath();
  g.fill();
  g.stroke();
  // Cheeks.
  g.fillStyle = 'rgba(255, 120, 120, 0.28)';
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(side * R * 0.55, R * 0.38, 26 * u, 16 * u, 0, 0, Math.PI * 2);
    g.fill();
  }
  // Eyes, blinking for 0.14 s every 3.3 s.
  const blink = (t % 3.3) > 3.16 ? 0.12 : 1;
  const eyeY = R * 0.06;
  g.fillStyle = ink;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.ellipse(side * R * 0.38, eyeY, 13 * u, 16 * u * blink, 0, 0, Math.PI * 2);
    g.fill();
    if (blink === 1) {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(side * R * 0.38 + 4 * u, eyeY - 6 * u, 4.5 * u, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ink;
    }
  }
  // Eyebrows.
  g.lineWidth = 8 * u;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.arc(side * R * 0.38, eyeY - 30 * u, 30 * u, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
  }
  // Glasses: two rounded frames with a bridge and a light reflection.
  g.lineWidth = 11 * u;
  g.strokeStyle = '#231a33';
  for (const side of [-1, 1]) {
    const lx = side * R * 0.38;
    g.fillStyle = 'rgba(214, 226, 255, 0.18)';
    g.beginPath();
    g.roundRect(lx - 56 * u, eyeY - 44 * u, 112 * u, 86 * u, 30 * u);
    g.fill();
    g.stroke();
    g.save();
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    g.lineWidth = 6 * u;
    g.beginPath();
    g.moveTo(lx + 18 * u, eyeY - 30 * u);
    g.lineTo(lx + 36 * u, eyeY - 12 * u);
    g.stroke();
    g.restore();
  }
  g.beginPath();
  g.moveTo(-R * 0.38 + 56 * u, eyeY - 6 * u);
  g.quadraticCurveTo(0, eyeY - 20 * u, R * 0.38 - 56 * u, eyeY - 6 * u);
  g.stroke();
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(side * (R * 0.38 + 56 * u), eyeY - 10 * u);
    g.lineTo(side * R * 0.93, eyeY - 18 * u);
    g.stroke();
  }
  // Nose and a gentle smile.
  g.strokeStyle = ink;
  g.lineWidth = 7 * u;
  g.beginPath();
  g.moveTo(-4 * u, R * 0.2);
  g.quadraticCurveTo(10 * u, R * 0.32, -8 * u, R * 0.36);
  g.stroke();
  g.lineWidth = 9 * u;
  g.beginPath();
  g.arc(0, R * 0.42, 46 * u, Math.PI * 0.18, Math.PI * 0.82);
  g.stroke();
  g.restore();
}

/** Which camera picture a sample recording carries: the tests' plain one or the README character. */
export type FixtureCamera = 'plain' | 'character';

async function encodeVideo(width: number, height: number, frames: number, draw: (g: CanvasRenderingContext2D, t: number) => void): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const parts: { d: Uint8Array; p: number | null }[] = [];
  // Like the recorders: the macOS helper writes H.264 with the OS (hardware) encoder, so the A and
  // B builds (both with H.264 through the OS) use H.264 in MP4; the VP8 build, which has no H.264
  // at all, records VP8 in WebM (Chromium's recorder).
  // A machine without a hardware H.264 encoder (a Windows CI runner) gets VP9 in the same MP4
  // container; only the hardware encoder is ever asked (never OpenH264).
  const vp8 = FIXTURE_MIME === 'video/webm';
  const h264 = PATENT_POOL_CODECS && !vp8 && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width, height, bitrate: 8e6, framerate: FPS, hardwareAcceleration: 'prefer-hardware' }).then((s) => !!s.supported, () => false));
  const codec = h264 ? 'avc1.640028' : vp8 ? 'vp8' : 'vp09.00.41.08';
  const video: Mp4VideoConfig = h264 ? { codec: 'avc1', width, height } : { codec: 'vp09', width, height, codecString: codec };
  const sink = async (d: Uint8Array, p: number | null) => { parts.push({ d: d.slice(), p }); };
  const w = vp8 ? new WebmWriter({ video: { codec: 'V_VP8', width, height }, sink }) : new Mp4Writer({ video, sink });
  let chain = Promise.resolve();
  const enc = new VideoEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength);
      c.copyTo(d);
      if (meta?.decoderConfig?.description && h264) video.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp;
      const key = c.type === 'key';
      chain = chain.then(() => (w instanceof WebmWriter ? w.addVideo(d, ts, key) : w.addVideo(d, ts, 1e6 / FPS, key)));
    },
    error: (e) => { throw e; },
  });
  enc.configure(h264
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

export async function synthesizeRecording(seconds = 8, lang: FixtureLang = 'tr', look: FixtureCamera = 'plain'): Promise<SyntheticRecording> {
  const camera = look === 'character' ? drawCharacter : drawCamera;
  const frames = Math.round(seconds * FPS);
  const [screen, cameraFile, mic] = await Promise.all([
    encodeVideo(W, H, frames, (g, t) => drawScreen(g, t, lang)),
    encodeVideo(1280, 720, frames, (g, t) => camera(g, 1280, 720, t)),
    encodeTone(seconds),
  ]);
  return {
    screen, camera: cameraFile, videoMime: FIXTURE_MIME, mic, cursorLog: cursorLogFor(seconds), durationMs: seconds * 1000,
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

/**
 * A 1024×768 (4:3) screen video like the Windows click driver's (tests/real-capture-web/windows-clicks.ps1):
 * a busy blue-grey desktop with a 240 px magenta square in a 20 px black frame in the middle, still.
 * The interface test exports it and measures the square in the exported frame (uitest.ts).
 */
export const KNOWN_SQUARE = { screenW: 1024, screenH: 768, x: 392, y: 264, size: 240, frame: 20 } as const;
export async function synthesizeSquareScreen(seconds = 3): Promise<{ screen: Uint8Array; videoMime: 'video/mp4' | 'video/webm'; width: number; height: number }> {
  const { screenW: w, screenH: h, x, y, size, frame } = KNOWN_SQUARE;
  const screen = await encodeVideo(w, h, Math.round(seconds * FPS), (g) => {
    g.fillStyle = '#284670';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#dcdcdc';
    for (let r = 20; r < h; r += 14) for (let c = 10; c < w; c += 90) g.fillRect(c, r, 60, 2);
    g.fillStyle = '#000';
    g.fillRect(x - frame, y - frame, size + 2 * frame, size + 2 * frame);
    g.fillStyle = '#ff00ff';
    g.fillRect(x, y, size, size);
  });
  return { screen, videoMime: FIXTURE_MIME, width: w, height: h };
}
