// Independent audit harness (not part of the project). Synthetic data only.
// Privacy: two different synthetic "secrets" must give byte-identical output wherever the
// area is hidden. Export: encoded + decoded frames must contain no secret-colored pixels in
// the hidden range. Performance: render / encode throughput and memory.
import { Compositor } from '@zeyvola/compositor';
import {
  addCameraLayout, addPrivacy, addRecording, addZoom, createProject, evaluate, presetTransition, removeSegment,
  setActiveVariant, splitAt, type PrivacyEffect, type Project,
} from '@zeyvola/project-model';
import { Mp4Writer, WebmWriter } from '@zeyvola/media-web';
import { frameDuration, secondsToTicks as sec } from '@zeyvola/timing';

declare global { interface Window { audit: { report(r: unknown): Promise<void>; metrics(): Promise<unknown> } } }

type Check = { group: string; name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const perf: Record<string, unknown> = {};
const push = (group: string, name: string, ok: boolean, detail?: string) => checks.push({ group, name, ok, detail });

const FPS = { num: 30, den: 1 };
const FD = frameDuration(FPS);
const at = (n: number) => n * FD;
const SW = 1280; const SH = 800; // synthetic screen source
const BOX = { x: 380, y: 300, w: 520, h: 120 };
const REGION = { x: 360 / SW, y: 290 / SH, w: 560 / SW, h: 140 / SH };

/** Synthetic screen: blue-grey gradient, a GREEN box with a fake phone number (the "secret"). */
function screen(secret: string, dx = 0): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, SW, SH);
  grad.addColorStop(0, '#203040'); grad.addColorStop(1, '#405060');
  g.fillStyle = grad; g.fillRect(0, 0, SW, SH);
  g.fillStyle = '#d0d4dc'; g.fillRect(80, 80, 220, 640); // unrelated UI
  g.fillStyle = '#00e000'; g.fillRect(BOX.x + dx, BOX.y, BOX.w, BOX.h);
  g.fillStyle = '#000000'; g.font = 'bold 64px sans-serif'; g.fillText(secret, BOX.x + dx + 20, BOX.y + 85);
  return c;
}
function cameraCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 480;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7a4a2a'; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#e0b090'; g.beginPath(); g.arc(320, 220, 120, 0, Math.PI * 2); g.fill();
  return c;
}

function base(effect: PrivacyEffect, padFrames = 0): Project {
  let p = createProject('audit');
  p = addRecording(p, {
    id: 'rec_a', createdAt: '', duration: sec(10),
    sources: {
      screen: { kind: 'screen', file: 's', mime: 'video/mp4', width: SW, height: SH, startOffset: 0, duration: sec(10) },
      camera: { kind: 'camera', file: 'c', mime: 'video/mp4', width: 640, height: 480, startOffset: 0, duration: sec(10) },
    },
    capture: { backend: 'web', platform: 'audit', target: { kind: 'display', label: '', bounds: { x: 0, y: 0, w: SW, h: SH }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
    syncOffsets: {}, markers: [],
  });
  p = { ...p, style: { ...p.style, background: { kind: 'solid', color: '#1d2230' } } };
  return addPrivacy(p, {
    recordingId: 'rec_a', start: sec(2), end: sec(4), origin: 'manual', region: REGION, keyframes: [], effect, cornerRadius: 0.1, padFrames,
  }).project;
}

const canvas = document.createElement('canvas');
const comp = new Compositor(canvas, { preserveDrawingBuffer: true });
const cam = cameraCanvas();
const A = screen('0555 000 00 01');
const B = screen('0555 999 99 98');

function render(p: Project, t: number, src: HTMLCanvasElement, w = 1280, h = 720): Uint8Array {
  const plan = evaluate(p, t, { size: { width: w, height: h } });
  comp.render(plan, { screen: src, screenSize: { width: SW, height: SH }, camera: cam, cameraSize: { width: 640, height: 480 } });
  const gl = comp.gl;
  const out = new Uint8Array(plan.width * plan.height * 4);
  gl.readPixels(0, 0, plan.width, plan.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}
const diff = (a: Uint8Array, b: Uint8Array) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const green = (px: Uint8ClampedArray | Uint8Array) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 1]! > 150 && px[i]! < 90 && px[i + 2]! < 90) n++; return n; };
function sizeOf(p: Project) { const v = p.variants.find((x) => x.id === p.activeVariantId)!; const k = 720 / Math.min(v.width, v.height); return { w: Math.round(v.width * k), h: Math.round(v.height * k) }; }

/** For each frame: hidden ⇔ outputs for the two secrets are byte-identical. */
function frames(group: string, label: string, p: Project, hidden: number[], visible: number[], srcA = (_n: number) => A, srcB = (_n: number) => B) {
  const { w, h } = sizeOf(p);
  const bad: string[] = [];
  for (const n of hidden) { const d = diff(render(p, at(n), srcA(n), w, h), render(p, at(n), srcB(n), w, h)); if (d !== 0) bad.push(`kare ${n}: ${d} bayt fark (gizli olmalı)`); }
  for (const n of visible) { const d = diff(render(p, at(n), srcA(n), w, h), render(p, at(n), srcB(n), w, h)); if (d === 0) bad.push(`kare ${n}: fark yok (görünür olmalı)`); }
  push(group, label, bad.length === 0, bad.length ? bad.slice(0, 4).join('; ') : `gizli ${hidden.length} kare aynı, görünür ${visible.length} kare farklı`);
}

function privacyTests() {
  const G = '1-zaman';
  frames(G, 'Opak, payısız: 2,0–4,0 sn (kare 60–119) gizli; 59 ve 120 görünür', base({ kind: 'solid', color: '#000000' }, 0), [60, 61, 90, 118, 119], [0, 30, 59, 120, 150]);
  frames(G, 'Opak, 2 kare güvenlik payı: kare 58–121 gizli; 57 ve 122 görünür', base({ kind: 'solid', color: '#000000' }, 2), [58, 59, 60, 119, 120, 121], [57, 122]);
  frames(G, 'Buzlu cam: kare 60–119 gizli; 59 ve 120 görünür', base({ kind: 'frosted' }, 0), [60, 90, 119], [59, 120]);

  const C = '2-kesme';
  { // remove the first second of the recording
    let p = base({ kind: 'solid', color: '#000000' }, 0);
    p = splitAt(p, sec(1));
    p = removeSegment(p, p.sequence.segments[0]!.id);
    frames(C, 'İlk 1 sn silindi: gizleme zaman çizelgesinde 1,0–3,0 sn’ye kaydı', p, [30, 60, 89], [0, 29, 90]);
  }
  { // cut out 2.5–3.0 s inside the hidden range
    let p = base({ kind: 'solid', color: '#000000' }, 0);
    p = splitAt(p, sec(2.5));
    p = splitAt(p, sec(3.0));
    p = removeSegment(p, p.sequence.segments[1]!.id);
    frames(C, 'Gizli aralığın içinden 0,5 sn kesildi: kesimin iki yanı da gizli', p, [60, 74, 75, 104], [59, 105]);
  }

  const Z = '3-zoom-kamera';
  {
    const p0 = base({ kind: 'solid', color: '#000000' }, 0);
    const p = addZoom(p0, { recordingId: 'rec_a', start: sec(1), end: sec(5), origin: 'manual', mode: 'region', center: { x: REGION.x + REGION.w / 2, y: REGION.y + REGION.h / 2 }, scale: 2.5, enter: presetTransition('smooth'), exit: presetTransition('smooth') }).project;
    frames(Z, '2,5× zoom gizli alana yakınlaşırken (geçiş dahil)', p, [60, 66, 75, 90, 119], [45, 59, 120, 135]);
    const off = addZoom(p0, { recordingId: 'rec_a', start: sec(1), end: sec(5), origin: 'manual', mode: 'region', center: { x: 0.25, y: 0.3 }, scale: 1.8, enter: presetTransition('fast'), exit: presetTransition('fast') }).project;
    frames(Z, 'Zoom başka yere bakarken (alan kısmen kadrajda)', off, [60, 90, 119], []);
  }
  {
    let p = base({ kind: 'solid', color: '#000000' }, 0);
    const base0 = p.style.camera;
    // The camera's path crosses the area (1 → centre → top-left); its 2. konum is away from the secret.
    p = addCameraLayout(p, { recordingId: 'rec_a', start: sec(1.5), end: sec(4.5), origin: 'manual', layout: { ...base0, visible: true }, enter: presetTransition('smooth'), second: { position: { x: 0.2, y: 0.25 }, size: 0.3 }, split: 0.4 }).project;
    frames(Z, 'Dinamik kamera alanın üstünden geçerken', p, [60, 75, 84, 90, 119], [59, 120]);
    // When the camera itself covers the secret after the area ends, nothing leaks either (camera on top).
    const pc = addCameraLayout(base({ kind: 'solid', color: '#000000' }, 0), { recordingId: 'rec_a', start: sec(1.5), end: sec(4.5), origin: 'manual', layout: { ...base0, visible: true }, enter: presetTransition('smooth'), second: { position: { x: 0.5, y: 0.45 }, size: 0.45 }, split: 0.4 }).project;
    frames(Z, 'Kamera sırrın üstündeyken (alan bittikten sonra da) sır görünmüyor', pc, [60, 90, 119, 120, 125], [150]);
  }

  const F = '4-formatlar';
  for (const v of ['v_16x9', 'v_9x16', 'v_1x1', 'v_4x5']) {
    const p = setActiveVariant(base({ kind: 'solid', color: '#000000' }, 0), v);
    frames(F, `Format ${p.variants.find((x) => x.id === v)!.name}: kare 60–119 gizli`, p, [60, 90, 119], [59, 120]);
    const pz = addZoom(p, { recordingId: 'rec_a', start: sec(1), end: sec(5), origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.45 }, scale: 2.2, enter: presetTransition('smooth'), exit: presetTransition('smooth') }).project;
    frames(F, `Format ${p.variants.find((x) => x.id === v)!.name} + zoom`, pz, [60, 75, 119], []);
  }

  const M = '5-hareketli';
  { // secret slides 400 px right between 2 s and 4 s; the area follows with two keyframes
    const dxAt = (n: number) => Math.max(0, Math.min(400, ((n / 30 - 2) / 2) * 400));
    let p = base({ kind: 'solid', color: '#000000' }, 0);
    const r0 = REGION; const r1 = { ...REGION, x: REGION.x + 400 / SW };
    p = { ...p, privacy: p.privacy.map((it) => ({ ...it, region: r0, keyframes: [{ t: sec(2), region: r0 }, { t: sec(4), region: r1 }] })) };
    const cache = new Map<string, HTMLCanvasElement>();
    const src = (s: string) => (n: number) => { const k = `${s}${n}`; if (!cache.has(k)) cache.set(k, screen(s === 'A' ? '0555 000 00 01' : '0555 999 99 98', dxAt(n))); return cache.get(k)!; };
    // Within one frame the content may keep moving; the area is placed for the frame start.
    frames(M, 'Anahtar karelerle hareket eden alan, hareket eden içeriği izliyor', p, [60, 70, 80, 90, 100, 110, 119], [59, 120], src('A'), src('B'));
  }

  const E = '6-efekt-sızıntı';
  for (const effect of [{ kind: 'blur', strength: 0.8 }, { kind: 'pixelate', block: 18 }] as PrivacyEffect[]) {
    const p = base(effect, 0);
    const d = diff(render(p, at(90), A), render(p, at(90), B));
    push(E, `${effect.kind}: iki farklı sırrın çıktısı ${d === 0 ? 'aynı' : 'farklı'} (farklıysa bilgi sızar)`, true, `${d} bayt fark — beklenen: >0 (bu efektler güvenli değildir, arayüz uyarıyor)`);
  }
}

// ─── Export: encode → our container writer → Chromium decode → pixels ─────
async function encodeFile(format: 'mp4' | 'webm', p: Project, src: HTMLCanvasElement, nFrames: number, w: number, h: number) {
  const parts: { data: Uint8Array; pos: number | null }[] = [];
  const sink = async (data: Uint8Array, position: number | null) => { parts.push({ data: data.slice(), pos: position }); };
  const videoCfg: { codec: 'avc1'; width: number; height: number; description?: Uint8Array } = { codec: 'avc1', width: w, height: h };
  const mp4 = format === 'mp4' ? new Mp4Writer({ video: videoCfg, sink }) : null;
  const webm = format === 'webm' ? new WebmWriter({ video: { codec: 'V_VP9', width: w, height: h }, sink }) : null;
  let chain = Promise.resolve();
  const config: VideoEncoderConfig = format === 'mp4'
    ? { codec: w * h > 2_100_000 ? 'avc1.640033' : 'avc1.640028', width: w, height: h, bitrate: 8e6, framerate: 30, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }
    : { codec: w * h > 2_100_000 ? 'vp09.00.51.08' : 'vp09.00.41.08', width: w, height: h, bitrate: 8e6, framerate: 30 };
  const enc = new VideoEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      if (meta?.decoderConfig?.description) videoCfg.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp; const key = c.type === 'key';
      chain = chain.then(() => (mp4 ? mp4.addVideo(d, ts, 1e6 / 30, key) : webm!.addVideo(d, ts, key)));
    },
    error: (e) => { throw e; },
  });
  enc.configure(config);
  const t0 = performance.now();
  for (let i = 0; i < nFrames; i++) {
    const plan = evaluate(p, at(i), { size: { width: w, height: h } });
    comp.render(plan, { screen: src, screenSize: { width: SW, height: SH }, camera: cam, cameraSize: { width: 640, height: 480 } });
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30), duration: Math.round(1e6 / 30) });
    enc.encode(f, { keyFrame: i % 60 === 0 });
    f.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush(); enc.close();
  await chain;
  if (mp4) await mp4.finish(); else await webm!.finish(33);
  const ms = performance.now() - t0;
  let size = 0; let pos = 0;
  for (const part of parts) { const a = part.pos ?? pos; size = Math.max(size, a + part.data.length); if (part.pos === null) pos += part.data.length; }
  const file = new Uint8Array(size); pos = 0;
  for (const part of parts) { const a = part.pos ?? pos; file.set(part.data, a); if (part.pos === null) pos += part.data.length; }
  return { file, ms, fps: nFrames / (ms / 1000) };
}

async function decodeFrames(file: Uint8Array, type: string, ns: number[], w: number, h: number) {
  const url = URL.createObjectURL(new Blob([file], { type }));
  const v = document.createElement('video'); v.muted = true; v.src = url;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('decode failed')); });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const out: Record<number, Uint8ClampedArray> = {};
  for (const n of ns) {
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = (n + 0.5) / 30; });
    g.drawImage(v, 0, 0, w, h);
    out[n] = g.getImageData(0, 0, w, h).data;
  }
  URL.revokeObjectURL(url);
  return { frames: out, duration: v.duration };
}

async function exportTests() {
  const G = '7-dışa-aktarma';
  let p = base({ kind: 'solid', color: '#000000' }, 0);
  p = addZoom(p, { recordingId: 'rec_a', start: sec(1), end: sec(5), origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.45 }, scale: 2, enter: presetTransition('smooth'), exit: presetTransition('smooth') }).project;
  p = addCameraLayout(p, { recordingId: 'rec_a', start: sec(1.5), end: sec(4.5), origin: 'manual', layout: { ...p.style.camera, visible: true }, enter: presetTransition('smooth'), second: { position: { x: 0.3, y: 0.3 }, size: 0.35 } }).project;
  for (const v of ['v_16x9', 'v_9x16'] as const) {
    const pv = setActiveVariant(p, v);
    const { w, h } = sizeOf(pv);
    for (const format of ['mp4', 'webm'] as const) {
      try {
        const enc = await encodeFile(format, pv, A, 180, w, h);
        const ns = [30, 59, 60, 61, 75, 90, 105, 118, 119, 120, 150];
        const dec = await decodeFrames(enc.file, format === 'mp4' ? 'video/mp4' : 'video/webm', ns, w, h);
        const leaks = [60, 61, 75, 90, 105, 118, 119].map((n) => [n, green(dec.frames[n]!)] as const).filter(([, g]) => g > 0);
        const visibleOk = green(dec.frames[30]!) > 50 && green(dec.frames[150]!) > 50;
        push(G, `${format.toUpperCase()} ${v.slice(2)}: gizli karelerde (60–119) sırrın rengi hiç yok`, leaks.length === 0 && visibleOk,
          leaks.length ? `sızıntı: ${leaks.map(([n, g]) => `kare ${n}: ${g} px`).join(', ')}` : `görünür karelerde sır var (kontrol), gizli karelerde 0 px; süre ${dec.duration.toFixed(2)} sn`);
        // Preview vs export: mean absolute difference per channel.
        let sum = 0; let cnt = 0;
        for (const n of [30, 90, 150]) {
          const ref = render(pv, at(n), A, w, h); const got = dec.frames[n]!;
          // readPixels is bottom-up; canvas is top-down.
          for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
            const i = (y * w + x) * 4; const j = ((h - 1 - y) * w + x) * 4;
            for (let k = 0; k < 3; k++) { sum += Math.abs(ref[j + k]! - got[i + k]!); cnt++; }
          }
        }
        const mad = sum / cnt;
        push(G, `${format.toUpperCase()} ${v.slice(2)}: önizleme ile dışa aktarılan kare tutarlı`, mad < 6, `ortalama mutlak fark ${mad.toFixed(2)} / 255 (sıkıştırma kaybı dahil)`);
        (perf.exportSmall ??= {} as Record<string, string>) as Record<string, string>;
        (perf.exportSmall as Record<string, string>)[`${format} ${w}x${h}`] = `${enc.fps.toFixed(1)} kare/sn (180 kare)`;
      } catch (e) {
        push(G, `${format.toUpperCase()} ${v.slice(2)}: dışa aktarma`, false, String(e));
      }
    }
  }
}

// ─── Performance ────────────────────────────────────────────────────────────
async function perfTests() {
  let p = base({ kind: 'blur', strength: 0.8 }, 0);
  p = addPrivacy(p, { recordingId: 'rec_a', start: sec(0), end: sec(10), origin: 'manual', region: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 }, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.1, padFrames: 0 }).project;
  p = addZoom(p, { recordingId: 'rec_a', start: sec(0), end: sec(10), origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.45 }, scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') }).project;
  const gl = comp.gl;
  const renderMs: Record<string, string> = {};
  const one = new Uint8Array(4);
  for (const [w, h] of [[1920, 1080], [3840, 2160]] as const) {
    for (let i = 0; i < 10; i++) { render(p, at(90), A, w, h); }
    const t0 = performance.now();
    const N = 60;
    for (let i = 0; i < N; i++) {
      const plan = evaluate(p, at(60 + i), { size: { width: w, height: h } });
      comp.render(plan, { screen: A, screenSize: { width: SW, height: SH }, camera: cam, cameraSize: { width: 640, height: 480 } });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); // waits for the GPU
    }
    renderMs[`${w}x${h}`] = `${((performance.now() - t0) / N).toFixed(2)} ms/kare (blur + buzlu cam + zoom + kamera)`;
  }
  perf.compositor = renderMs;

  const enc: Record<string, string> = {};
  for (const [format, w, h, n] of [['mp4', 1920, 1080, 300], ['mp4', 3840, 2160, 120], ['webm', 1920, 1080, 150], ['webm', 3840, 2160, 60]] as const) {
    try {
      const r = await encodeFile(format, p, A, n, w, h);
      enc[`${format === 'mp4' ? 'H.264' : 'VP9'} ${w}x${h}`] = `${r.fps.toFixed(1)} kare/sn (${n} kare, ${(r.file.length / 1e6).toFixed(1)} MB)`;
    } catch (e) { enc[`${format} ${w}x${h}`] = `hata: ${String(e)}`; }
  }
  perf.encode = enc;

  // Long export in memory: 2 minutes of 1080p30 — watch memory.
  const mem = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  const before = { heap: mem(), metrics: await window.audit.metrics() };
  const long = await encodeFile('mp4', p, A, 3600, 1920, 1080);
  const after = { heap: mem(), metrics: await window.audit.metrics() };
  perf.long = { frames: 3600, fps: long.fps.toFixed(1), sizeMB: (long.file.length / 1e6).toFixed(1), heapBeforeMB: (before.heap / 1e6).toFixed(1), heapAfterMB: (after.heap / 1e6).toFixed(1) };
  perf.metricsBefore = before.metrics;
  perf.metricsAfter = after.metrics;
}

(async () => {
  const started = performance.now();
  const errors: string[] = [];
  for (const [name, fn] of [['privacy', async () => privacyTests()], ['export', exportTests], ['perf', perfTests]] as const) {
    try { await fn(); } catch (e) { errors.push(`${name}: ${String((e as Error).stack ?? e)}`); }
  }
  await window.audit.report({ checks, perf, errors, totalMs: performance.now() - started, gpu: (() => { const gl = comp.gl; const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '?'; })() });
})();
