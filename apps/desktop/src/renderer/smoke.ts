/**
 * In-app self tests (run with `pnpm smoke`). Exercises the real renderer stack — WebGL2
 * compositor, privacy effects, WebCodecs encoders, our MP4/WebM writers and Chromium's
 * decoder — and reports a capability matrix for this machine.
 */
import { Compositor } from '@zeyvola/compositor';
import { Mp4Writer, WebmWriter, type Mp4VideoConfig } from '@zeyvola/media-web';
import {
  addCameraMoveAt, addMagnifier, addPrivacy, addRecording, createProject, evaluate, parseCursorLog, prepareCursor, presetTransition, sourceToCanvas,
  type CursorTrack, type PrivacyEffect, type Project,
} from '@zeyvola/project-model';
import { secondsToTicks } from '@zeyvola/timing';
import { suggestZooms } from '@zeyvola/zoom-engine';
import { api } from './api';
import { t } from './i18n';
import { checkExportSupport, pickVideoConfig } from './export/exporter';
import { synthesizeRecording } from './smoke-fixtures';
import { createSampleProject, decodeSound, exportsRel, frame, mediaUrl, probeVideo, routedExport, sleep, until, type Check } from './testing/harness';
import { PATENT_POOL_CODECS, PROFILE } from '../shared/distribution';
import { importVideo } from './screens/editor/import-media';
import { warmUpCamera } from './capture-devices';
import type { PickedFile } from '@zeyvola/protocol';
import type { EditorStore } from './state/editor-store';
import { addPrivacy as addPrivacyCmd, conflictsFor, parseProject, removeSegment, sequenceDuration, setActiveVariant, timelineToSource, trimSegment, layoutSegments, type TrackItem } from '@zeyvola/project-model';


function syntheticScreen(secret: string, w = 1280, h = 800): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#203040');
  grad.addColorStop(1, '#405060');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.fillRect(380, 300, 520, 120);
  g.fillStyle = '#000000';
  g.font = 'bold 64px sans-serif';
  g.fillText(secret, 400, 385);
  return c;
}

function projectWith(effect: PrivacyEffect): Project {
  let p = createProject('smoke');
  p = addRecording(p, {
    id: 'rec_smoke', createdAt: new Date().toISOString(), duration: secondsToTicks(10),
    sources: { screen: { kind: 'screen', file: 'x.mp4', mime: 'video/mp4', width: 1280, height: 800, startOffset: 0, duration: secondsToTicks(10) } },
    capture: { backend: 'web', platform: 'smoke', target: { kind: 'display', label: 'test', bounds: { x: 0, y: 0, w: 1280, h: 800 }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
    syncOffsets: {}, markers: [],
  });
  return addPrivacy(p, {
    recordingId: 'rec_smoke', start: secondsToTicks(1), end: secondsToTicks(3), origin: 'manual',
    region: { x: 360 / 1280, y: 290 / 800, w: 560 / 1280, h: 140 / 800 }, keyframes: [], effect, cornerRadius: 0.1, padFrames: 0,
  }).project;
}

function regionPixels(comp: Compositor, project: Project, t: number, src: HTMLCanvasElement): Uint8Array {
  const plan = evaluate(project, t, { size: { width: 960, height: 540 } });
  comp.render(plan, { screen: src, screenSize: { width: src.width, height: src.height } });
  const gl = comp.gl;
  const r = project.privacy[0]!.region;
  const a = sourceToCanvas(plan, { x: r.x + r.w * 0.1, y: r.y + r.h * 0.15 })!;
  const b = sourceToCanvas(plan, { x: r.x + r.w * 0.9, y: r.y + r.h * 0.85 })!;
  const w = Math.floor(b.x - a.x);
  const h = Math.floor(b.y - a.y);
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(Math.floor(a.x), plan.height - Math.floor(a.y) - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

async function privacyChecks(checks: Check[]): Promise<void> {
  const canvas = document.createElement('canvas');
  const comp = new Compositor(canvas, { preserveDrawingBuffer: true });
  const a = syntheticScreen('0555 123 45 67');
  const b = syntheticScreen('0532 987 65 43');
  // Solid must be exactly the chosen color inside the region.
  {
    const p = projectWith({ kind: 'solid', color: '#ff00ff' });
    const px = regionPixels(comp, p, secondsToTicks(2), a);
    let bad = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i]! - 255) > 2 || px[i + 1]! > 2 || Math.abs(px[i + 2]! - 255) > 2) bad++;
    checks.push({ name: 'Opak gizleme alanı tam renkle kaplıyor', ok: bad === 0, detail: `${bad} farklı piksel` });
  }
  // Frosted must not depend on what is inside the region: two different secrets → identical output.
  {
    const p = projectWith({ kind: 'frosted' });
    const pa = regionPixels(comp, p, secondsToTicks(2), a);
    const pb = regionPixels(comp, p, secondsToTicks(2), b);
    let diff = 0;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;
    checks.push({ name: 'Buzlu cam, alanın içindeki içerikten bilgi taşımıyor', ok: diff === 0, detail: `${diff} farklı bayt (0 olmalı)` });
  }
  // Outside the item's time range the content must be untouched (and differ between secrets).
  {
    const p = projectWith({ kind: 'solid', color: '#ff00ff' });
    const pa = regionPixels(comp, p, secondsToTicks(5), a);
    const pb = regionPixels(comp, p, secondsToTicks(5), b);
    let diff = 0;
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) diff++;
    checks.push({ name: 'Zaman aralığı dışında görüntü değişmiyor', ok: diff > 0 });
  }
  for (const effect of [{ kind: 'blur', strength: 0.8 }, { kind: 'pixelate', block: 18 }] as PrivacyEffect[]) {
    const p = projectWith(effect);
    const t0 = performance.now();
    regionPixels(comp, p, secondsToTicks(2), a);
    checks.push({ name: `Gizleme efekti çalışıyor: ${effect.kind}`, ok: true, ms: performance.now() - t0 });
  }
  comp.dispose();
}

/**
 * Magnifier on the real WebGL compositor: it enlarges what is under the pointer by the chosen
 * factor, leaves the rest of the frame alone, and never shows what a privacy area hides.
 */
async function magnifierChecks(checks: Check[]): Promise<void> {
  const canvas = document.createElement('canvas');
  const comp = new Compositor(canvas, { preserveDrawingBuffer: true });
  const size = { width: 960, height: 540 };
  // Pointer resting on the secret box of syntheticScreen (and inside projectWith's privacy region).
  const at = { x: 640 / 1280, y: 360 / 800 };
  const cursors = { rec_smoke: prepareCursor({ samples: Array.from({ length: 201 }, (_, i) => ({ t: secondsToTicks(i * 0.05), ...at })), clicks: [], scrolls: [] }) };
  /** A magnifier range over recording seconds [from, to). */
  const lens = (p: Project, size: number, zoom: number, from = 0, to = 10) =>
    addMagnifier(p, { recordingId: 'rec_smoke', start: secondsToTicks(from), end: secondsToTicks(to), origin: 'manual', size, zoom }).project;
  const grab = (p: Project, src: HTMLCanvasElement, t: number) => {
    const plan = evaluate(p, t, { size, cursors });
    comp.render(plan, { screen: src, screenSize: { width: src.width, height: src.height } });
    const out = new Uint8Array(size.width * size.height * 4);
    comp.gl.readPixels(0, 0, size.width, size.height, comp.gl.RGBA, comp.gl.UNSIGNED_BYTE, out);
    const px = (x: number, y: number) => {
      const i = ((size.height - 1 - Math.floor(y)) * size.width + Math.floor(x)) * 4;
      return [out[i]!, out[i + 1]!, out[i + 2]!] as const;
    };
    return { plan, out, px };
  };
  const white = ([r, g, b]: readonly number[]) => r! > 200 && g! > 200 && b! > 200;
  /** Width of the white run through (x, y) along the row. */
  const run = (px: (x: number, y: number) => readonly number[], x: number, y: number) => {
    let l = 0;
    let r = 0;
    while (l < 400 && white(px(x - l - 1, y))) l++;
    while (r < 400 && white(px(x + r + 1, y))) r++;
    return white(px(x, y)) ? l + r + 1 : 0;
  };

  // A small white square right under the pointer: the lens must show it `zoom` times wider.
  {
    const src = document.createElement('canvas');
    src.width = 1280; src.height = 800;
    const g = src.getContext('2d')!;
    g.fillStyle = '#406080'; g.fillRect(0, 0, 1280, 800);
    g.fillStyle = '#ffffff'; g.fillRect(620, 340, 40, 40);
    const base = projectWith({ kind: 'solid', color: '#ff00ff' });
    const t = secondsToTicks(5); // after the privacy range
    const off = grab(base, src, t);
    const on = grab(lens(base, 300, 3), src, t);
    // A range that ended before this moment leaves the frame exactly as without a magnifier.
    const after = grab(lens(base, 300, 3, 0, 4), src, t);
    let diffAfter = 0;
    for (let i = 0; i < off.out.length; i++) if (off.out[i] !== after.out[i]) diffAfter++;
    checks.push({ name: 'Büyüteç yalnızca kendi zaman aralığında görünüyor', ok: !!on.plan.magnifier && after.plan.magnifier === null && diffAfter === 0, detail: `aralık dışında ${diffAfter} farklı bayt` });
    const m = on.plan.magnifier;
    const f = m?.focus ?? { x: 0, y: 0 };
    const wOff = run(off.px, f.x, f.y);
    const wOn = run(on.px, f.x, f.y);
    const ratio = wOff > 0 ? wOn / wOff : 0;
    checks.push({ name: 'Büyüteç imlecin altını seçilen oranda büyütüyor (3×)', ok: !!m && off.plan.magnifier === null && ratio > 2.7 && ratio < 3.3, detail: `kare ${wOff} px → ${wOn} px (${ratio.toFixed(2)}×)` });
    // Outside the lens and its shadow, the frame is byte-identical.
    let changedOutside = 0;
    let changedInside = 0;
    if (m) {
      const pad = m.shadow.blur * 3 + 4;
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const i = ((size.height - 1 - y) * size.width + x) * 4;
          const diff = off.out[i] !== on.out[i] || off.out[i + 1] !== on.out[i + 1] || off.out[i + 2] !== on.out[i + 2];
          if (!diff) continue;
          const inside = x >= m.rect.x - pad && x <= m.rect.x + m.rect.w + pad && y >= m.rect.y - pad && y <= m.rect.y + m.rect.h + pad;
          if (inside) changedInside++; else changedOutside++;
        }
      }
    }
    checks.push({ name: 'Büyüteç merceğin dışındaki görüntüye dokunmuyor', ok: !!m && changedOutside === 0 && changedInside > 0, detail: `dışarıda ${changedOutside}, mercekte ${changedInside} değişen piksel` });
  }

  // Privacy: the lens reads the filtered picture, so an opaque area stays opaque inside the lens...
  {
    const p = lens(projectWith({ kind: 'solid', color: '#ff00ff' }), 300, 2);
    const { plan, px } = grab(p, syntheticScreen('0555 123 45 67'), secondsToTicks(2));
    const m = plan.magnifier;
    let bad = 0;
    let n = 0;
    if (m) {
      const r = m.rect.w * 0.3;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const [cr, cg, cb] = px(m.focus.x + dx, m.focus.y + dy);
          n++;
          if (Math.abs(cr - 255) > 3 || cg > 3 || Math.abs(cb - 255) > 3) bad++;
        }
      }
    }
    checks.push({ name: 'Büyüteç opak gizleme alanının altını göstermiyor', ok: !!m && n > 0 && bad === 0, detail: `${n} pikselden ${bad} farklı` });
  }
  // ...and frosted glass under the lens carries no information from inside the area.
  {
    const p = lens(projectWith({ kind: 'frosted' }), 300, 2.5);
    const a = grab(p, syntheticScreen('0555 123 45 67'), secondsToTicks(2));
    const b = grab(p, syntheticScreen('0532 987 65 43'), secondsToTicks(2));
    const m = a.plan.magnifier;
    let diff = 0;
    if (m) {
      for (let y = Math.floor(m.rect.y); y < m.rect.y + m.rect.h; y++) {
        for (let x = Math.floor(m.rect.x); x < m.rect.x + m.rect.w; x++) {
          const pa = a.px(x, y);
          const pb = b.px(x, y);
          if (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) diff++;
        }
      }
    }
    checks.push({ name: 'Büyüteç buzlu cam altındaki içerikten bilgi taşımıyor', ok: !!m && diff === 0, detail: `${diff} farklı piksel (0 olmalı)` });
  }
  comp.dispose();
}

/**
 * Chromium keeps at most 16 WebGL contexts per page and drops the oldest beyond that. Every
 * thumbnail, privacy check picture and export makes its own compositor, so a closed one must
 * give its context back at once: otherwise the preview, or an export that is running, loses
 * its context after a while and draws nothing.
 */
async function contextLifetime(checks: Check[]): Promise<void> {
  const first = document.createElement('canvas');
  const keep = new Compositor(first);
  let lost = false;
  first.addEventListener('webglcontextlost', () => { lost = true; });
  const held: HTMLCanvasElement[] = []; // kept alive on purpose: garbage collection must not be what frees them
  for (let i = 0; i < 40; i++) {
    const c = document.createElement('canvas');
    held.push(c);
    new Compositor(c).dispose();
  }
  await sleep(300);
  const ok = !lost && !keep.gl.isContextLost();
  keep.dispose();
  checks.push({ name: 'Derleyici kapatılınca WebGL bağlamını bırakır: 40 aç-kapa sonrası ilk bağlam sağlam', ok, detail: `${held.length} aç-kapa, ilk bağlam ${ok ? 'sağlam' : 'kayboldu'}` });
}

async function codecMatrix(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // The B build carries no H.264/AAC/HEVC strings at all (tools/codec-audit.mjs checks the bundle);
  // its package-level codec check is `--codec-probe`.
  const video: [string, string, number, number, number][] = [
    ...(PATENT_POOL_CODECS ? [
      ['H.264 1080p30', 'avc1.640028', 1920, 1080, 30], ['H.264 1080p60', 'avc1.64002a', 1920, 1080, 60],
      ['H.264 4K30', 'avc1.640033', 3840, 2160, 30], ['H.264 4K60', 'avc1.640034', 3840, 2160, 60],
      ['HEVC 4K30', 'hvc1.1.6.L153.B0', 3840, 2160, 30],
    ] as [string, string, number, number, number][] : []),
    ['VP9 1080p30', 'vp09.00.41.08', 1920, 1080, 30], ['VP9 4K30', 'vp09.00.51.08', 3840, 2160, 30],
    ['VP8 1080p30', 'vp8', 1920, 1080, 30], ['VP8 4K30', 'vp8', 3840, 2160, 30], ['AV1 1080p30', 'av01.0.08M.08', 1920, 1080, 30],
  ];
  for (const [name, codec, width, height, framerate] of video) {
    const res: string[] = [];
    // H.264/HEVC are only ever asked of the hardware encoder: asking Chromium about software
    // H.264 starts OpenH264, which no Zeyvola code path may do (checked from the smoke log).
    const accels = codec.startsWith('avc1') || codec.startsWith('hvc1') ? ['prefer-hardware'] as const : ['prefer-hardware', 'prefer-software'] as const;
    for (const hw of accels) {
      try {
        const s = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate: 10e6, hardwareAcceleration: hw });
        res.push(`${hw === 'prefer-hardware' ? 'donanım' : 'yazılım'}:${s.supported ? 'evet' : 'hayır'}`);
      } catch { res.push(`${hw}:hata`); }
    }
    out[`kodlama ${name}`] = res.join(' ');
  }
  for (const [name, codec] of [...(PATENT_POOL_CODECS ? [['AAC', 'mp4a.40.2']] as const : []), ['Opus', 'opus']] as const) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
      out[`ses kodlama ${name}`] = s.supported ? 'evet' : 'hayır';
    } catch { out[`ses kodlama ${name}`] = 'hata'; }
  }
  for (const [name, codec] of [...(PATENT_POOL_CODECS ? [['H.264', 'avc1.640028'], ['HEVC', 'hvc1.1.6.L120.B0']] as const : []), ['VP9', 'vp09.00.41.08'], ['VP8', 'vp8'], ['AV1', 'av01.0.08M.08']] as const) {
    try {
      const s = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 });
      out[`çözme ${name}`] = s.supported ? 'evet' : 'hayır';
    } catch { out[`çözme ${name}`] = 'hata'; }
  }
  for (const m of [...PROFILE.recorderVideo, ...PROFILE.recorderAudio]) {
    out[`MediaRecorder ${m}`] = MediaRecorder.isTypeSupported(m) ? 'evet' : 'hayır';
  }
  return out;
}

/** Encodes 2 s of compositor output, muxes it with our writer and checks Chromium can play and seek it. */
const EXPORT_ORDER = ['mp4', 'webm'] as const;

/**
 * How this device writes MP4 (export/route.ts), asked before any MP4 check runs:
 *   webCodecsH264  WebCodecs offers a hardware H.264 encoder (our own MP4 writer's round trip needs it)
 *   mp4Route       the route the export window picks: webcodecs, mf (Windows' Media Foundation through
 *                  the helper) or webm-fallback (WebM instead of MP4, said plainly)
 *   mp4Missing     MP4 cannot be written at all (the window's message); MP4 exports are then skipped
 * The export checks below go through routedExport, so they write what the window would write.
 */
let webCodecsH264 = true;
let mp4Route: string | null = null;
let mp4Missing: string | null = null;
const usableFormats = () => EXPORT_ORDER.filter((f) => PROFILE.formats.includes(f) && !(f === 'mp4' && mp4Missing));
const roundTripFormats = () => usableFormats().filter((f) => f !== 'mp4' || webCodecsH264);
const mainFormat = (): 'mp4' | 'webm' => (PROFILE.defaultExport === 'mp4' && mp4Missing ? 'webm' : PROFILE.defaultExport);

async function mp4Support(checks: Check[]): Promise<void> {
  webCodecsH264 = await pickVideoConfig('mp4', 1920, 1080, 30, 10e6).then(() => true, () => false);
  const sample = await createSampleProject(2, 'MP4 desteği');
  const { project } = await loadProject(sample.id);
  const ask = (format: 'mp4' | 'webm') => checkExportSupport(project, { variantId: 'v_16x9', format, resolution: '1080', fps: 30, quality: 'high', includeAudio: true });
  const mp4 = await ask('mp4');
  if (mp4.ok) {
    mp4Route = mp4.route.kind;
    if (webCodecsH264 && mp4.route.kind === 'webcodecs') return; // the usual path; the exports below check it
    const win = (await api.appInfo()).platform === 'win32';
    // Without a hardware H.264 encoder: Windows' Media Foundation encoders, or WebM said plainly.
    const ok = mp4.route.kind === 'mf' ? win && /Windows/.test(mp4.encoder) : mp4.route.kind === 'webm-fallback' && !!mp4.notice && mp4.written === 'webm';
    checks.push({
      name: 'MP4 yolu ekran kartı H.264 kodlayıcısı yokken: Windows\'ta Media Foundation yazılım kodlayıcısı, olmazsa açık bildirimle WebM',
      ok,
      detail: `WebCodecs donanım H.264 ${webCodecsH264 ? 'var' : 'yok'} · yol ${mp4.route.kind}${'reason' in mp4.route ? ` (${mp4.route.reason})` : ''} · kodlayıcı "${mp4.encoder}" · yazılacak ${mp4.written}${mp4.notice ? ` · not "${mp4.notice}"` : ''}`,
    });
    return;
  }
  mp4Missing = mp4.message;
  const webm = await ask('webm');
  checks.push({
    name: 'MP4 yazılamayan cihaz: dışa aktarma başlamadan söylenir, WebM yazılabilir',
    ok: /H\.264|AAC/.test(mp4.message) && webm.ok,
    detail: `MP4: "${mp4.message}" · WebM: ${webm.ok ? webm.encoder : webm.message} · bu cihazda MP4 dışa aktarma denetimleri atlandı`,
  });
}
/** Files from the round trips (picture + sound), reused as "videos from the computer". */
const roundTripFiles: Partial<Record<'mp4' | 'webm', Uint8Array>> = {};

async function roundTrip(format: 'mp4' | 'webm', checks: Check[]): Promise<void> {
  const width = 1280;
  const height = 720;
  const fps = 30;
  const frames = 60;
  const t0 = performance.now();
  const parts: { data: Uint8Array; pos: number | null }[] = [];
  const sink = async (data: Uint8Array, position: number | null) => { parts.push({ data: data.slice(), pos: position }); };
  try {
    const { config, label } = await pickVideoConfig(format, width, height, fps, 6e6);
    const vp9 = config.codec.startsWith('vp09');
    const videoCfg: Mp4VideoConfig = vp9 ? { codec: 'vp09', width, height, codecString: config.codec } : { codec: 'avc1', width, height };
    // The distribution's first audio choice for this format (AAC in A's MP4, Opus otherwise).
    const aCodec = PROFILE.exports[format]!.audio[0]!;
    const audioCfg: { codec: 'mp4a' | 'opus'; sampleRate: number; channels: number; description?: Uint8Array } = { codec: aCodec === 'opus' ? 'opus' : 'mp4a', sampleRate: 48000, channels: 2 };
    const mp4 = format === 'mp4' ? new Mp4Writer({ video: videoCfg, audio: audioCfg, sink }) : null;
    const webm = format === 'webm' ? new WebmWriter({ video: { codec: config.codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width, height }, audio: { codec: 'A_OPUS', sampleRate: 48000, channels: 2 }, sink }) : null;
    let chain = Promise.resolve();
    // Audio: 2 s sine.
    const aSupported = (await AudioEncoder.isConfigSupported({ codec: aCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
    if (aSupported) {
      const ae = new AudioEncoder({
        output: (c, meta) => {
          const d = new Uint8Array(c.byteLength);
          c.copyTo(d);
          if (meta?.decoderConfig?.description) audioCfg.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
          const ts = c.timestamp;
          const dur = c.duration ?? 21333;
          chain = chain.then(() => (mp4 ? mp4.addAudio(d, ts, dur) : webm!.addAudio(d, ts)));
        },
        error: () => undefined,
      });
      ae.configure({ codec: aCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      const n = 96000;
      const pcm = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) { const v = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.2; pcm[i] = v; pcm[n + i] = v; }
      ae.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data: pcm }));
      await ae.flush();
      ae.close();
    }
    const canvas = document.createElement('canvas');
    const comp = new Compositor(canvas);
    const src = syntheticScreen('ZEYVOLA');
    let p = createProject('rt');
    p = addRecording(p, {
      id: 'rec_rt', createdAt: '', duration: secondsToTicks(2),
      sources: { screen: { kind: 'screen', file: 'x', mime: 'video/mp4', width: 1280, height: 800, startOffset: 0, duration: secondsToTicks(2) } },
      capture: { backend: 'web', platform: 'smoke', target: { kind: 'display', label: '', bounds: { x: 0, y: 0, w: 1280, h: 800 }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
      syncOffsets: {}, markers: [],
    });
    p = { ...p, zooms: [{ id: 'z', type: 'zoom', recordingId: 'rec_rt', start: 0, end: secondsToTicks(2), origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.45 }, scale: 2, enter: presetTransition('fast'), exit: presetTransition('fast') }] };
    const enc = new VideoEncoder({
      output: (c, meta) => {
        const d = new Uint8Array(c.byteLength);
        c.copyTo(d);
        if (meta?.decoderConfig?.description && !vp9) videoCfg.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
        const ts = c.timestamp;
        const key = c.type === 'key';
        chain = chain.then(() => (mp4 ? mp4.addVideo(d, ts, 1e6 / fps, key) : webm!.addVideo(d, ts, key)));
      },
      error: (e) => { throw e; },
    });
    enc.configure({ ...config, width, height });
    for (let i = 0; i < frames; i++) {
      const plan = evaluate(p, secondsToTicks(i / fps), { size: { width, height } });
      comp.render(plan, { screen: src, screenSize: { width: 1280, height: 800 } });
      const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      enc.encode(f, { keyFrame: i % 30 === 0 });
      f.close();
    }
    await enc.flush();
    enc.close();
    comp.dispose();
    await chain;
    if (mp4) await mp4.finish(); else await webm!.finish(33);
    // Assemble the positioned writes into a file.
    let size = 0;
    let pos = 0;
    for (const part of parts) { const at = part.pos ?? pos; size = Math.max(size, at + part.data.length); if (part.pos === null) pos += part.data.length; }
    const file = new Uint8Array(size);
    pos = 0;
    for (const part of parts) { const at = part.pos ?? pos; file.set(part.data, at); if (part.pos === null) pos += part.data.length; }
    const encodeMs = performance.now() - t0;
    roundTripFiles[format] = file;
    const url = URL.createObjectURL(new Blob([file], { type: format === 'mp4' ? 'video/mp4' : 'video/webm' }));
    const v = document.createElement('video');
    v.muted = true;
    v.src = url;
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error(v.error?.message ?? 'çözülemedi')); setTimeout(() => rej(new Error('zaman aşımı')), 8000); });
    const duration = v.duration;
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = 1.0; setTimeout(res, 4000); });
    const seekedOk = Math.abs(v.currentTime - 1.0) < 0.05;
    URL.revokeObjectURL(url);
    checks.push({
      name: `${format.toUpperCase()} uçtan uca: kodla → kendi yazıcımız → Chromium oynatır ve atlar`,
      ok: Math.abs(duration - 2) < 0.15 && v.videoWidth === width && seekedOk,
      detail: `${label}, süre ${duration.toFixed(3)} sn, ${v.videoWidth}×${v.videoHeight}, ses ${aSupported ? 'var' : 'yok'}, ${(file.length / 1024).toFixed(0)} KB, ${(frames / (encodeMs / 1000)).toFixed(0)} kare/sn`,
      ms: encodeMs,
    });
  } catch (e) {
    checks.push({ name: `${format.toUpperCase()} uçtan uca`, ok: false, detail: (e as Error).message });
  }
}

function zoomPerf(checks: Check[]): void {
  // One hour of 60 Hz pointer samples with a click every 4 s.
  const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
  let x = 0.5;
  let y = 0.5;
  for (let s = 0; s < 3600; s += 1 / 60) {
    if (Math.floor(s * 60) % 240 === 0) { x = Math.random(); y = Math.random(); track.clicks.push({ t: secondsToTicks(s), x, y, button: 'left', kind: 'down' }); }
    track.samples.push({ t: secondsToTicks(s), x, y });
  }
  const t0 = performance.now();
  const items = suggestZooms({ recordingId: 'r', duration: secondsToTicks(3600), track, hasClicks: true, sensitivity: 'medium', defaults: { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') } });
  const ms = performance.now() - t0;
  checks.push({ name: '1 saatlik kayıtta zoom önerisi süresi', ok: ms < 3000, detail: `${items.length} öneri, ${ms.toFixed(0)} ms`, ms });
}

const pointer = (target: EventTarget, type: string, x: number, y: number) =>
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1, pointerType: 'mouse' }));

/**
 * Adding zooms and camera moves: ranges drawn on the camera lane, and presses on the preview
 * with the zoom / camera tool, which always work at the playhead and keep the tool on.
 */
async function addingRanges(store: EditorStore, checks: Check[], shot: (name: string) => Promise<void>): Promise<void> {
  const sec = (v: number) => secondsToTicks(v);
  const n0 = store.project.cameraLayouts.length;
  const manualZooms = () => store.project.zooms.filter((z) => z.origin === 'manual');
  const z0 = manualZooms().length;
  const startPlayhead = store.getState().playhead;
  const pps = store.getState().pxPerSecond;

  // 1) Drag on the camera lane, twice, in both directions.
  const body = document.querySelector('.tr-camlayout .tl-row-body');
  let drawn = false;
  let lens: string[] = [];
  if (body) {
    const r = body.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const draw = async (a: number, b: number) => {
      pointer(body, 'pointerdown', r.left + a * pps, y);
      pointer(window, 'pointermove', r.left + (a + 0.05) * pps, y);
      pointer(window, 'pointermove', r.left + b * pps, y);
      pointer(window, 'pointerup', r.left + b * pps, y);
      await frame();
    };
    await draw(1, 2.5);
    await draw(6.5, 4.5);
    const moves = store.project.cameraLayouts;
    lens = moves.map((m) => ((m.end - m.start) / 705_600_000).toFixed(2));
    drawn = moves.length === n0 + 2 && store.getState().playhead === startPlayhead
      && moves.every((m) => conflictsFor(store.project, 'cameraLayouts', m as TrackItem).length === 0);
  }
  checks.push({ name: 'Dinamik kamera: satırda sürükleyerek farklı zamanlara birden çok aralık eklenir, imleç oynamaz', ok: drawn, detail: `süreler: ${lens.join(', ')} sn` });
  while (store.project.cameraLayouts.length > n0 && store.getState().canUndo) store.undo();

  const overlay = document.querySelector('.preview-overlay');
  const press = async (fx: number, fy: number, drag?: [number, number]) => {
    const o = overlay!.getBoundingClientRect();
    const x = o.left + fx * o.width;
    const y = o.top + fy * o.height;
    pointer(overlay!, 'pointerdown', x, y);
    await frame();
    if (drag) { pointer(overlay!, 'pointermove', x + drag[0], y + drag[1]); await frame(); }
    pointer(overlay!, 'pointerup', x + (drag?.[0] ?? 0), y + (drag?.[1] ?? 0));
    await frame();
    await frame();
  };

  // 2) Zoom tool: each press adds a zoom at the playhead; a press inside one re-aims it.
  let zoomOk = false;
  let zoomDetail = '';
  if (overlay) {
    store.select(null);
    store.setTool('zoom');
    await frame();
    store.setPlayhead(sec(0.5)); await frame(); await frame();
    await press(0.3, 0.3);
    store.setPlayhead(sec(4)); await frame(); await frame();
    await press(0.7, 0.6);
    const second = manualZooms().find((z) => z.start === sec(4));
    const c0 = JSON.stringify(second?.center);
    store.setPlayhead(sec(4.5)); await frame(); await frame();
    await press(0.2, 0.7);
    const after = manualZooms();
    zoomDetail = `elle zoom: ${z0} → ${after.length}, araç: ${store.getState().tool}`;
    zoomOk = after.length === z0 + 2 && !!second && JSON.stringify(after.find((z) => z.id === second.id)?.center) !== c0
      && store.getState().tool === 'zoom' && store.getState().playhead === sec(4.5);
  }
  checks.push({ name: 'Zoom aracı: önizlemeye her basış oynatma imlecinde yeni zoom ekler, araç açık kalır', ok: zoomOk, detail: zoomDetail });

  // 3) Camera tool: the same at the playhead, also after another move is selected.
  let camOk = false;
  let camDetail = '';
  if (overlay) {
    store.setTool('camera');
    store.setPlayhead(sec(0.5)); await frame(); await frame();
    await press(0.25, 0.3);
    store.setPlayhead(sec(4)); await frame(); await frame(); // the first move is still selected
    await press(0.75, 0.3);
    const moves = store.project.cameraLayouts;
    const first = moves.find((m) => m.start === sec(0.5));
    const second = moves.find((m) => m.start === sec(4));
    const look = (id?: string) => { const m = store.project.cameraLayouts.find((x) => x.id === id); return JSON.stringify([m?.layout.position, m?.second]); };
    const firstPos = look(first?.id);
    const secondPos = look(second?.id);
    // Drag while inside the second move: only that one changes.
    store.setPlayhead(sec(4.5)); await frame(); await frame();
    await press(0.75, 0.3, [-160, 90]);
    const pos = look;
    // Pressing the camera itself (no drag) still adds a range there.
    store.setPlayhead(sec(7.2)); await frame(); await frame();
    const box = document.querySelector('.camera-box')?.getBoundingClientRect();
    const o = overlay.getBoundingClientRect();
    if (box) await press((box.left + box.width / 2 - o.left) / o.width, (box.top + box.height / 2 - o.top) / o.height);
    const count = store.project.cameraLayouts.length;
    await shot('09-adding-ranges');
    camDetail = `kamera hareketi: ${n0} → ${count}, araç: ${store.getState().tool}`;
    camOk = !!first && !!second && count === n0 + 3 && pos(first.id) === firstPos && pos(second.id) !== secondPos
      && store.getState().tool === 'camera' && store.project.cameraLayouts.every((m) => conflictsFor(store.project, 'cameraLayouts', m as TrackItem).length === 0);
  }
  checks.push({ name: 'Dinamik kamera aracı: önizlemeye her basış oynatma imlecinde yeni aralık ekler (başka aralık seçiliyken de)', ok: camOk, detail: camDetail });

  // 4) After the playhead jumps, the camera outline sits on the camera (no stale overlay).
  let syncOk = false;
  let syncDetail = '';
  if (overlay) {
    store.setPlayhead(sec(3.8));
    await frame(); await frame(); await frame();
    const box = document.querySelector('.camera-box')?.getBoundingClientRect();
    const o = overlay.getBoundingClientRect();
    const cam = evaluate(store.project, sec(3.8), { cursors: store.getState().cursors, size: { width: 1920, height: 1080 } }).camera;
    if (box && cam) {
      const dx = (box.left + box.width / 2 - o.left) / o.width - (cam.rect.x + cam.rect.w / 2) / 1920;
      const dy = (box.top + box.height / 2 - o.top) / o.height - (cam.rect.y + cam.rect.h / 2) / 1080;
      syncDetail = `fark ${(Math.hypot(dx, dy) * 100).toFixed(2)}%`;
      syncOk = Math.hypot(dx, dy) < 0.01;
    }
  }
  checks.push({ name: 'Önizleme: oynatma imleci atlayınca kamera çerçevesi kamerayla aynı yerde', ok: syncOk, detail: syncDetail });

  // Leave the project as it was for the export checks.
  while ((store.project.cameraLayouts.length > n0 || manualZooms().length > z0) && store.getState().canUndo) store.undo();
  store.select(null);
  store.setTool('select');
  store.setPlayhead(startPlayhead);
}

/**
 * With a tool on, a press anywhere on the timeline (another row, a clip, another kind's item)
 * adds the tool's item at that moment in the tool's own row.
 */
async function addingAnywhere(store: EditorStore, checks: Check[], shot: (name: string) => Promise<void>): Promise<void> {
  const sec = (v: number) => secondsToTicks(v);
  const pps = store.getState().pxPerSecond;
  const ph = store.getState().playhead;
  const counts = () => ({
    cam: store.project.cameraLayouts.length,
    zoom: store.project.zooms.filter((z) => z.origin === 'manual').length,
    priv: store.project.privacy.length,
  });
  const c0 = counts();
  const rowBody = (cls: string) => document.querySelector(`.${cls} .tl-row-body`);
  const at = (el: Element | null, secs: number) => {
    const body = el?.closest('.tl-row-body') ?? el;
    const r = body!.getBoundingClientRect();
    return { x: r.left + secs * pps, y: (el as Element).getBoundingClientRect().top + (el as Element).getBoundingClientRect().height / 2 };
  };
  const click = async (el: Element | null, secs: number) => {
    if (!el) return;
    const p = at(el, secs);
    pointer(el, 'pointerdown', p.x, p.y);
    pointer(window, 'pointerup', p.x, p.y);
    await frame();
  };
  const startsAt = (list: { start: number }[], secs: number) => list.some((i) => Math.abs(i.start - sec(secs)) < sec(0.05));

  // Dinamik kamera: press the Privacy row, then the Screen clip.
  store.select(null);
  store.setTool('camera');
  await frame();
  await click(rowBody('tr-privacy'), 5.2);
  await click(document.querySelector('.tl-seg-screen'), 1.0);
  // ...and drag on the Microphone row.
  const mic = document.querySelector('.tl-seg-mic');
  if (mic) {
    const a = at(mic, 4.2);
    const b = at(mic, 4.9);
    pointer(mic, 'pointerdown', a.x, a.y);
    pointer(window, 'pointermove', a.x + 5, a.y);
    pointer(window, 'pointermove', b.x, b.y);
    pointer(window, 'pointerup', b.x, b.y);
    await frame();
  }
  const cams = store.project.cameraLayouts;
  const camOk = cams.length === c0.cam + 3 && startsAt(cams, 5.2) && startsAt(cams, 1.0) && startsAt(cams, 4.2);

  // Zoom: press the Microphone clip, then a camera move.
  store.setTool('zoom');
  await frame();
  await click(document.querySelector('.tl-seg-mic'), 0.3);
  const x6 = at(rowBody('tr-camlayout'), 6.0).x;
  const camItem = [...document.querySelectorAll('.tl-camera')].find((el) => { const r = el.getBoundingClientRect(); return r.left < x6 && x6 < r.right; });
  await click(camItem ?? null, 6.0);
  const zooms = store.project.zooms.filter((z) => z.origin === 'manual');
  const zoomOk = zooms.length === c0.zoom + 2 && startsAt(zooms, 0.3) && startsAt(zooms, 6.0) && store.project.cameraLayouts.length === c0.cam + 3;

  // Gizle: press the Zoom row.
  store.setTool('privacy');
  await frame();
  await click(rowBody('tr-zoom'), 6.4);
  const privOk = store.project.privacy.length === c0.priv + 1 && startsAt(store.project.privacy, 6.4);

  // Guide line while hovering with the camera tool on.
  store.setTool('camera');
  await frame();
  const hover = at(rowBody('tr-privacy'), 2.6);
  const content = document.querySelector('.tl-content');
  if (content) content.dispatchEvent(new PointerEvent('pointermove', { clientX: hover.x, clientY: hover.y, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  await frame();
  await shot('10-add-anywhere');
  const c1 = counts();
  checks.push({
    name: 'Araç açıkken zaman çizelgesinde herhangi bir satıra basmak, aracın kendi satırına ekler',
    ok: camOk && zoomOk && privOk && store.getState().playhead === ph,
    detail: `kamera ${c0.cam}→${c1.cam}, zoom ${c0.zoom}→${c1.zoom}, gizleme ${c0.priv}→${c1.priv}`,
  });
  while ((store.project.cameraLayouts.length > c0.cam || store.project.zooms.filter((z) => z.origin === 'manual').length > c0.zoom
    || store.project.privacy.length > c0.priv) && store.getState().canUndo) store.undo();
  store.select(null);
  store.setTool('select');
}

/**
 * The two positions of a camera move: added from the timeline it shows "2 · Konum seçin" and an
 * empty slot on the preview; a press on the preview picks the 2. konum, frame 1 can be dragged,
 * and the line in the block sets when the camera moves.
 */
async function twoPositions(store: EditorStore, checks: Check[], shot: (name: string) => Promise<void>): Promise<void> {
  const sec = (v: number) => secondsToTicks(v);
  const pps = store.getState().pxPerSecond;
  const n0 = store.project.cameraLayouts.length;
  store.select(null);
  store.setTool('camera');
  store.setPlayhead(sec(1));
  await frame(); await frame();
  const body = document.querySelector('.tr-camlayout .tl-row-body');
  const overlay = document.querySelector('.preview-overlay');
  let emptyShown = false;
  let picked = false;
  let firstMoved = false;
  let splitMoved = false;
  let detail = '';
  if (body && overlay) {
    const r = body.getBoundingClientRect();
    pointer(body, 'pointerdown', r.left + 4.2 * pps, r.top + r.height / 2);
    pointer(window, 'pointerup', r.left + 4.2 * pps, r.top + r.height / 2);
    await frame(); await frame(); await frame();
    const move = () => store.project.cameraLayouts.find((c) => Math.abs(c.start - sec(4.2)) < sec(0.05));
    const m0 = move();
    emptyShown = !!m0 && !m0.second && !!document.querySelector('.tl-cam-part.is-empty') && !!document.querySelector('.tl-cam-divider')
      && !!document.querySelector('.cam-frame.is-empty .cam-slot-text') && !!document.querySelector('.cam-position.is-empty');
    await shot('11-camera-pick-second');
    // Pick the 2. konum: top centre of the frame.
    const o = overlay.getBoundingClientRect();
    pointer(overlay, 'pointerdown', o.left + o.width * 0.5, o.top + o.height * 0.18);
    await frame();
    pointer(overlay, 'pointerup', o.left + o.width * 0.5, o.top + o.height * 0.18);
    await frame(); await frame();
    const m1 = move();
    const secondLabel = document.querySelector('.tl-cam-part.is-second:not(.is-empty)')?.textContent ?? '';
    picked = !!m1?.second && Math.abs(m1.second.position.x - 0.5) < 0.02 && secondLabel.includes(t("Üst orta")) && !document.querySelector('.cam-frame.is-empty');
    // Drag frame 1 to the left: only the 1. konum changes.
    const f1 = document.querySelector('.cam-frame.is-one')?.getBoundingClientRect();
    if (f1 && m1) {
      const x = f1.left + f1.width / 2;
      const y = f1.top + f1.height / 2;
      pointer(overlay, 'pointerdown', x, y);
      await frame();
      pointer(overlay, 'pointermove', x - o.width * 0.6, y);
      await frame();
      pointer(overlay, 'pointerup', x - o.width * 0.6, y);
      await frame(); await frame();
      const m2 = move()!;
      firstMoved = m2.layout.position.x < m1.layout.position.x - 0.3 && JSON.stringify(m2.second) === JSON.stringify(m1.second);
    }
    // Drag the line inside the block: the move happens later.
    const divider = document.querySelector('.tl-camera.is-selected .tl-cam-divider');
    if (divider) {
      const d = divider.getBoundingClientRect();
      const x = d.left + d.width / 2;
      const y = d.top + d.height / 2;
      pointer(divider, 'pointerdown', x, y);
      pointer(window, 'pointermove', x + 5, y);
      pointer(window, 'pointermove', x + 0.6 * pps, y);
      pointer(window, 'pointerup', x + 0.6 * pps, y);
      await frame(); await frame();
      splitMoved = (move()?.split ?? 0.5) > 0.6;
    }
    detail = `blok: "${document.querySelector('.tl-camera.is-selected')?.textContent ?? ''}"`;
    await shot('12-camera-two-positions');
  }
  checks.push({ name: 'Dinamik kamera: yeni harekette "2 · Konum seçin" ve önizlemede boş 2. konum alanı görünür', ok: emptyShown });
  checks.push({ name: 'Dinamik kamera: önizlemeye basınca 2. konum seçilir, blokta adı yazar', ok: picked, detail });
  checks.push({ name: 'Dinamik kamera: 1 numaralı çerçeve sürüklenince yalnızca 1. konum değişir', ok: firstMoved });
  checks.push({ name: 'Dinamik kamera: bloktaki çizgi sürüklenince geçiş anı değişir', ok: splitMoved });
  while (store.project.cameraLayouts.length > n0 && store.getState().canUndo) store.undo();
  store.select(null);
  store.setTool('select');
}

/**
 * Adding videos from the computer with the + at the end of the timeline. The system file
 * dialog is replaced by a stand-in that picks a file already in the project folder.
 */
async function importing(store: EditorStore, checks: Check[], shot: (name: string) => Promise<void>, silentFile: string): Promise<void> {
  const projectId = store.project.id;
  const pickPath = (path: string) => () => window.zeyvola.invoke('smoke:pickFile', { projectId, path }) as Promise<PickedFile>;
  const write = (path: string, data: Uint8Array) => window.zeyvola.invoke('smoke:writeFile', { projectId, path, data });
  const button = document.querySelector('.tl-add-clip');
  const lastSeg = [...document.querySelectorAll('.tl-seg-screen')].pop();
  const buttonAtEnd = !!button && !!lastSeg && button.getBoundingClientRect().left >= lastSeg.getBoundingClientRect().right;

  const scrollEnd = async () => { const el = document.querySelector('.tl-scroll'); if (el) el.scrollLeft = el.scrollWidth; await frame(); await frame(); };
  await scrollEnd();
  await shot('13-add-video-button');
  const segs0 = store.project.sequence.segments.length;
  const dur0 = sequenceDuration(store.project);
  let withSound = false;
  let silent = false;
  let detail = '';
  // Two videos with sound from the round trips: MP4 and WebM, or two WebM files where the
  // distribution only exports WebM (VP8 profile).
  // Two WebM files also where this device writes no MP4 (no H.264 encoder).
  const withMp4 = PROFILE.formats.length > 1 && !!roundTripFiles.mp4;
  const incoming = withMp4
    ? [['incoming/sesli.mp4', roundTripFiles.mp4], ['incoming/klip.webm', roundTripFiles.webm]] as const
    : [['incoming/sesli.webm', roundTripFiles.webm], ['incoming/klip.webm', roundTripFiles.webm]] as const;
  if (incoming.every(([, data]) => data)) {
    const oks: boolean[] = [];
    for (const [file, data] of incoming) await write(file, data!);
    for (const [file] of incoming) oks.push(await importVideo(store, pickPath(file)));
    const imported = Object.values(store.project.recordings).filter((r) => r.capture.backend === 'import');
    const added = sequenceDuration(store.project) - dur0;
    withSound = oks.every(Boolean) && imported.length === 2 && imported.every((r) => !!r.sources.screen && !!r.sources.system)
      && store.project.sequence.segments.length === segs0 + 2 && Math.abs(added / 705_600_000 - 4.1) < 0.3;
    detail = `eklenen süre ${(added / 705_600_000).toFixed(2)} sn, bölüm ${segs0} → ${store.project.sequence.segments.length}`;
  }
  // A video without sound gets no sound track.
  const n1 = Object.keys(store.project.recordings).length;
  const okSilent = await importVideo(store, pickPath(silentFile));
  const last = Object.values(store.project.recordings).filter((r) => r.capture.backend === 'import').pop();
  silent = okSilent && Object.keys(store.project.recordings).length === n1 + 1 && !!last && !last.sources.system;
  // Broken files and other file types are refused without changing the project.
  await write('incoming/bozuk.mp4', new TextEncoder().encode('bu bir video değil'));
  await write('incoming/not.txt', new TextEncoder().encode('metin'));
  const n2 = Object.keys(store.project.recordings).length;
  const okBroken = await importVideo(store, pickPath('incoming/bozuk.mp4'));
  const okText = await importVideo(store, pickPath('incoming/not.txt'));
  const refused = !okBroken && !okText && Object.keys(store.project.recordings).length === n2;
  await scrollEnd();
  const msg = document.querySelector('.toast')?.textContent ?? '';
  await shot('14-imported-videos');
  checks.push({ name: 'Hata mesajı sade: teknik önek gösterilmez', ok: !!msg && !msg.includes('Error invoking'), detail: msg.slice(0, 120) });
  checks.push({ name: 'Video ekle: + düğmesi zaman çizelgesinin sonunda', ok: buttonAtEnd });
  checks.push({ name: withMp4 ? 'Video ekle: MP4 ve WebM sona eklenir, kendi sesiyle' : 'Video ekle: iki WebM sona eklenir, kendi sesiyle', ok: withSound, detail });
  checks.push({ name: 'Video ekle: sessiz videoya ses izi eklenmez', ok: silent });
  checks.push({ name: 'Video ekle: bozuk dosya ve başka türler reddedilir, proje değişmez', ok: refused });
}

/** Real pointer events against the timeline DOM. */
async function timelineInteractions(store: EditorStore, checks: Check[]): Promise<void> {
  const fire = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
  const center = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  // 1) Clicking a camera/mic segment selects it and leaves the playhead alone.
  const seg = document.querySelector('.tl-seg-camera, .tl-seg-mic');
  const p0 = store.getState().playhead;
  if (seg) {
    const c = center(seg);
    fire(seg, 'pointerdown', c.x + 120, c.y);
    fire(window, 'pointerup', c.x + 120, c.y);
    await frame();
  }
  const s1 = store.getState();
  checks.push({ name: 'Zaman çizelgesi: alt izlere tıklamak seçer, oynatma imlecini oynatmaz', ok: !!seg && s1.selection?.kind === 'segment' && s1.playhead === p0 });

  // 2) Dragging a zoom far to the right stops at its neighbour; nothing overlaps.
  const zoomEl = document.querySelector('.tl-zoom');
  let noOverlap = false;
  let stuck = true;
  if (zoomEl) {
    const c = center(zoomEl);
    fire(zoomEl, 'pointerdown', c.x, c.y);
    fire(window, 'pointermove', c.x + 6, c.y);
    fire(window, 'pointermove', c.x + 3000, c.y);
    fire(window, 'pointerup', c.x + 3000, c.y);
    await frame();
    const p = store.project;
    noOverlap = p.zooms.every((z) => conflictsFor(p, 'zooms', z as TrackItem).length === 0);
    // 3) Hovering after release must not move anything.
    const before = JSON.stringify(p.zooms);
    const ph = store.getState().playhead;
    fire(window, 'pointermove', c.x - 400, c.y);
    await frame();
    stuck = JSON.stringify(store.project.zooms) !== before || store.getState().playhead !== ph;
    store.undo();
  }
  checks.push({ name: 'Zaman çizelgesi: zoom sürüklenince komşusunun üstüne binmiyor', ok: !!zoomEl && noOverlap });
  checks.push({ name: 'Zaman çizelgesi: bıraktıktan sonra fareyi gezdirmek hiçbir şeyi oynatmıyor', ok: !!zoomEl && !stuck });

  // 4) The playhead moves only when it is grabbed and dragged.
  const knob = document.querySelector('.tl-playhead-knob');
  const before = store.getState().playhead;
  if (knob) {
    const c = center(knob);
    fire(knob, 'pointerdown', c.x, c.y);
    fire(window, 'pointermove', c.x + 150, c.y);
    fire(window, 'pointerup', c.x + 150, c.y);
    await frame();
  }
  checks.push({ name: 'Zaman çizelgesi: oynatma imleci tutup sürükleyince hareket ediyor', ok: !!knob && store.getState().playhead > before });

  // 5) Cut mode: the button only arms the tool; a click on the tracks cuts there.
  const segsBefore = store.project.sequence.segments.length;
  store.setTool('cut');
  await frame();
  const segsAfterArming = store.project.sequence.segments.length;
  const screenSeg = document.querySelector('.tl-seg-screen');
  let cutOk = false;
  let toolbarState = '';
  if (screenSeg) {
    const r = screenSeg.getBoundingClientRect();
    const cx = r.left + r.width * 0.3;
    const cy = r.top + r.height / 2;
    fire(screenSeg, 'pointermove', cx, cy);
    await frame();
    await frame();
    const line = !!document.querySelector('.tl-cutline');
    const onLabel = document.querySelector('.stage-toolbar .segmented .is-on')?.textContent ?? '';
    const scissorsActive = !!document.querySelector('.transport-left .icon-btn.is-active');
    await window.zeyvola.invoke('smoke:shot', '07-cut-mode');
    const ph = store.getState().playhead;
    fire(screenSeg, 'pointerdown', cx, cy);
    fire(window, 'pointerup', cx, cy);
    await frame();
    toolbarState = `seçili araç düğmesi: "${onLabel}", makas düğmesi ${scissorsActive ? 'etkin' : 'etkin değil'}`;
    cutOk = onLabel === t("Kes") && scissorsActive && line && store.project.sequence.segments.length === segsBefore + 1 && store.getState().playhead === ph && store.getState().tool === 'cut';
    store.undo();
  }
  store.setTool('select');
  checks.push({ name: 'Kesme modu: buton sadece modu açar, tıklanan yerden keser, imleç oynamaz', ok: segsAfterArming === segsBefore && cutOk, detail: toolbarState });
}

/** Full flow on a synthetic recording: project → editor → auto zoom → privacy → export → playback. */
/**
 * The magnifier as the user sets it up: the Büyüteç tool from the tool bar, a range drawn on
 * the timeline's Büyüteç row, then its size and zoom from the side panel. It shows only in
 * that range. The range stays, so the real exports below include it.
 */
async function magnifierInEditor(store: EditorStore, checks: Check[], shot: (name: string) => Promise<void>): Promise<void> {
  const sec = (v: number) => secondsToTicks(v);
  store.select(null);
  const toolBtn = [...document.querySelectorAll<HTMLButtonElement>('.stage-toolbar [role="radio"]')].find((b) => b.textContent?.includes('Büyüteç'));
  toolBtn?.click();
  await until(() => store.getState().tool === 'magnifier', 2000);
  const toolOn = store.getState().tool === 'magnifier';
  // Draw 3.2 s → 5.0 s on the Büyüteç row (the pointer rests on the phone number from 3.4 s).
  const body = document.querySelector('.tr-magnifier .tl-row-body');
  const n0 = store.project.magnifiers.length;
  if (body) {
    const pps = store.getState().pxPerSecond;
    const r = body.getBoundingClientRect();
    const y = r.top + r.height / 2;
    pointer(body, 'pointerdown', r.left + 3.2 * pps, y);
    pointer(window, 'pointermove', r.left + 3.3 * pps, y);
    pointer(window, 'pointermove', r.left + 5.0 * pps, y);
    pointer(window, 'pointerup', r.left + 5.0 * pps, y);
  }
  const item = await until(() => store.project.magnifiers.length === n0 + 1 && store.project.magnifiers[n0], 2000);
  const len = item ? (item.end - item.start) / 705_600_000 : 0;
  const drawn = !!item && Math.abs(len - 1.8) < 0.1 && store.getState().selection?.kind === 'magnifier';
  // The selected range's own size and zoom, from the side panel.
  const setRange = (el: HTMLInputElement | undefined, v: number) => {
    if (!el) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await frame();
  const panel = document.querySelector('.selected-panel');
  const [sizeSlider, zoomSlider] = [...(panel?.querySelectorAll<HTMLInputElement>('input[type="range"]') ?? [])];
  setRange(sizeSlider, 400);
  await frame();
  setRange(zoomSlider, 3);
  await until(() => store.project.magnifiers.find((m) => m.id === item?.id)?.zoom === 3, 2000);
  store.endGesture();
  const it = store.project.magnifiers.find((m) => m.id === item?.id);
  const tabOn = document.querySelector('.inspector-tabs [aria-checked="true"]')?.textContent ?? '';
  const cursors = store.getState().cursors;
  const at = (s: number) => evaluate(store.project, sec(s), { cursors }).magnifier;
  const inside = at(3.8);
  const shown = !!inside && Math.abs(inside.rect.w - 400) < 0.5 && inside.zoom === 3 && at(2.5) === null && at(6) === null;
  store.setTool('select');
  store.setPlayhead(sec(3.8));
  await shot('07-editor-magnifier');
  checks.push({
    name: 'Büyüteç: araçla zaman çizelgesine aralık çizilir, boyutu ve yakınlaştırması ayarlanır, yalnızca o aralıkta görünür',
    ok: toolOn && drawn && tabOn.includes('Büyüteç') && it?.size === 400 && it.zoom === 3 && shown,
    detail: `araç ${toolOn ? 'açık' : 'kapalı'}, aralık ${len.toFixed(2)} sn, sekme "${tabOn}", ${it ? `${it.size} px · ${it.zoom}×` : 'yok'}, 3,8 sn: ${inside ? `${inside.rect.w.toFixed(0)} px mercek` : 'yok'}, 2,5 sn: ${at(2.5) ? 'var' : 'yok'}, 6 sn: ${at(6) ? 'var' : 'yok'}`,
  });
}

async function endToEnd(checks: Check[], shots: string[]): Promise<void> {
  const shot = async (name: string) => {
    await sleep(700);
    const r = (await window.zeyvola.invoke('smoke:shot', name)) as { file: string } | null;
    if (r) shots.push(r.file);
  };
  await shot('01-home-empty');
  const t0 = performance.now();
  const rec = await synthesizeRecording(8);
  const { id } = await api.createProject('Hesap ayarları turu');
  const recId = `rec_${crypto.randomUUID()}`;
  const dir = `media/${recId}`;
  const ext = rec.videoMime === 'video/webm' ? 'webm' : 'mp4';
  for (const [name, data] of [[`screen.${ext}`, rec.screen], [`camera.${ext}`, rec.camera], ['mic.m4a', rec.mic]] as const) {
    await window.zeyvola.invoke('smoke:writeFile', { projectId: id, path: `${dir}/${name}`, data });
  }
  await window.zeyvola.invoke('smoke:writeFile', { projectId: id, path: `${dir}/cursor.jsonl`, data: new TextEncoder().encode(rec.cursorLog) });
  const dur = secondsToTicks(rec.durationMs / 1000);
  await window.zeyvola.invoke('smoke:appendRecording', {
    projectId: id,
    recording: {
      id: recId, createdAt: new Date().toISOString(), duration: dur,
      sources: {
        screen: { kind: 'screen', file: `${dir}/screen.${ext}`, mime: rec.videoMime, width: rec.screenSize.width, height: rec.screenSize.height, fps: 30, startOffset: 0, duration: dur },
        camera: { kind: 'camera', file: `${dir}/camera.${ext}`, mime: rec.videoMime, width: rec.cameraSize.width, height: rec.cameraSize.height, fps: 30, startOffset: 0, duration: dur },
        mic: { kind: 'mic', file: `${dir}/mic.m4a`, mime: 'audio/mp4', sampleRate: 48000, channels: 1, startOffset: 0, duration: dur },
      },
      cursorFile: `${dir}/cursor.jsonl`,
      capture: { backend: 'native-macos', platform: 'smoke', target: { kind: 'display', label: 'Sentetik', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 1 }, cursorInFrames: false, hasClicks: true },
      syncOffsets: {}, markers: [],
    },
  });
  checks.push({ name: 'Sentetik kayıt üretildi ve projeye eklendi', ok: true, ms: performance.now() - t0, detail: `${(rec.screen.length / 1024).toFixed(0)} KB ekran, ${(rec.camera.length / 1024).toFixed(0)} KB kamera` });

  window.dispatchEvent(new CustomEvent('zeyvola:smoke-open', { detail: id }));
  const ed = await until(() => (window as unknown as { __zeyvolaEditor?: { store: EditorStore } }).__zeyvolaEditor);
  if (!ed) { checks.push({ name: 'Düzenleyici açıldı', ok: false }); return; }
  const store = ed.store;
  const zooms = await until(() => store.project.zooms.length > 0 && store.project.zooms.length, 12_000);
  checks.push({ name: 'Otomatik zoom önerileri ilk açılışta oluştu', ok: !!zooms, detail: `${zooms ?? 0} öneri` });
  // Privacy over the fake phone number from 3.0 s to 5.0 s.
  const pos = timelineToSource(store.project, secondsToTicks(3), layoutSegments(store.project));
  store.apply((p) => addPrivacyCmd(p, {
    recordingId: pos!.recordingId, start: secondsToTicks(3), end: secondsToTicks(5), origin: 'manual',
    region: rec.secretRegion, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
  }).project);
  store.setPlayhead(secondsToTicks(3.6));
  await sleep(600);
  await timelineInteractions(store, checks);
  store.setPlayhead(secondsToTicks(3.6));
  await until(() => store.getState().save === 'saved', 5000);
  await sleep(1200);
  await shot('02-editor');
  store.select({ kind: 'privacy', id: store.project.privacy[0]!.id });
  await shot('03-editor-privacy-selected');
  store.setTab('camera');
  store.select(null);
  await shot('04-editor-camera-tab');
  store.apply((p) => setActiveVariant(p, 'v_9x16'));
  store.setPlayhead(secondsToTicks(1.7));
  await shot('05-editor-vertical');
  store.apply((p) => setActiveVariant(p, 'v_16x9'));
  store.setExportOpen(true);
  await sleep(2500);
  await shot('06-export-dialog');
  store.setExportOpen(false);
  await magnifierInEditor(store, checks, shot);

  // Language: switching to English re-renders the whole editor; switching back restores Turkish.
  {
    store.setTool('camera');
    await api.setLanguage('en');
    await until(() => document.documentElement.lang === 'en', 3000);
    await frame();
    await frame();
    const toolbar = document.querySelector('.stage-toolbar')?.textContent ?? '';
    const exportLabel = document.querySelector('.topbar-right .btn-primary')?.textContent ?? '';
    const clippedTabs = (lang: string) => [...document.querySelectorAll<HTMLElement>('.inspector-tabs button span')]
      .filter((s) => s.scrollWidth > s.clientWidth + 0.5).map((s) => `${lang}:${s.textContent}`);
    const clipped = clippedTabs('en');
    await shot('08-editor-english');
    const enOk = toolbar.includes('Dynamic camera') && toolbar.includes('Cut') && exportLabel.includes('Export');
    await api.setLanguage('tr');
    await until(() => document.documentElement.lang === 'tr', 3000);
    await frame();
    await frame();
    const back = document.querySelector('.stage-toolbar')?.textContent ?? '';
    const trOk = back.includes('Dinamik kamera') && back.includes('Kes');
    clipped.push(...clippedTabs('tr'));
    store.setTool('select');
    checks.push({ name: 'Dil: İngilizceye geçince tüm düzenleyici çevrilir, Türkçeye geri döner', ok: enOk && trOk, detail: `EN araç çubuğu: "${toolbar.slice(0, 90)}", dışa aktar: "${exportLabel}"` });
    checks.push({ name: 'Ayar sekmelerinin adları iki dilde de kesilmeden sığıyor', ok: clipped.length === 0, detail: clipped.length ? `kesilen: ${clipped.join(', ')}` : '6 sekme' });
  }

  // Settings (⌘,) → Licenses section, as the user sees it.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));
  const lic = await until(() => document.querySelector('.settings-modal .licenses'), 4000);
  let licShown = false;
  if (lic) {
    await until(() => lic.querySelectorAll('.license-row').length >= 5, 4000);
    lic.querySelector<HTMLButtonElement>('.license-row .link')?.click();
    await frame();
    lic.scrollIntoView({ block: 'start' });
    await shot('15-licenses');
    licShown = lic.querySelectorAll('.license-row').length >= 5 && lic.querySelectorAll('.codec-row').length >= 7 && !!lic.querySelector('.license-text');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await frame();
  }
  checks.push({ name: 'Lisanslar: Ayarlar’da paketler, Electron ve codec tablosu görünüyor', ok: licShown && !document.querySelector('.settings-modal') });

  await addingRanges(store, checks, shot);
  await addingAnywhere(store, checks, shot);
  await twoPositions(store, checks, shot);
  await importing(store, checks, shot, `${dir}/screen.${ext}`);

  // Real export to disk, then play the file back through the media protocol.
  for (const format of usableFormats()) {
    const t1 = performance.now();
    const ctl = new AbortController();
    const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
      variantId: 'v_16x9', format, resolution: '1080', fps: 30, quality: 'high', includeAudio: true,
    }, () => undefined, ctl.signal);
    const ms = performance.now() - t1;
    let detail = result.message ?? '';
    let ok = result.phase === 'done' && !!result.path;
    if (ok && result.path) {
      const rel = exportsRel(result.path);
      const expected = sequenceDuration(store.project) / 705_600_000;
      // An MP4 is opened with the system's own decoders when the run has the probe (the packaged
      // app's Chromium has no AAC decoder); everything else with Chromium.
      const written = result.support?.ok ? result.support.written : format;
      const sys = written === 'mp4' ? await window.zeyvola.invoke('smoke:avCheck', { path: result.path, duration: expected }) as SystemProbe : null;
      let seen: { duration: number; width: number; height: number; by: string };
      if (sys && !sys.skipped) {
        seen = { duration: sys.duration, width: Math.round(sys.video?.width ?? 0), height: Math.round(sys.video?.height ?? 0), by: sys.engine ?? 'sistem' };
        if (!sys.ok) detail = `${sys.engine}: ${sys.problems.join('; ')} · `;
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.crossOrigin = 'anonymous';
        v.src = store.getState().mediaBase + rel.split('/').map(encodeURIComponent).join('/');
        const loaded = await new Promise<boolean>((res) => { v.onloadedmetadata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(false), 8000); });
        seen = { duration: loaded ? v.duration : Number.NaN, width: v.videoWidth, height: v.videoHeight, by: 'Chromium' };
      }
      ok = (!sys || sys.skipped || sys.ok) && Math.abs(seen.duration - expected) < 0.2 && seen.width === 1920 && seen.height === 1080;
      detail += `${result.encoder}, ${seen.by}: ${seen.width}×${seen.height}, ${seen.duration.toFixed(2)} sn (beklenen ${expected.toFixed(2)}), ${((result.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB, ${(result.total / (ms / 1000)).toFixed(1)} kare/sn`;
    }
    const via = result.support?.ok && result.support.route.kind !== 'webcodecs' ? ` [yol ${result.support.route.kind}, yazılan ${result.support.written}]` : '';
    checks.push({ name: `Gerçek proje dışa aktarımı ${format.toUpperCase()} 1080p30 (zoom + kamera + gizleme + büyüteç + ses)`, ok, detail: `${detail}${via}`, ms });
  }

  // Optional (ZEYVOLA_SMOKE_EXPORT_MATRIX=1): export time of the same project at 1080p/4K, 30/60 fps
  // in the distribution's default format, to compare distributions.
  if ((await api.appInfo()).smokeExportMatrix) {
    for (const [resolution, fps] of [['1080', 30], ['1080', 60], ['2160', 30], ['2160', 60]] as const) {
      const t1 = performance.now();
      const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
        variantId: 'v_16x9', format: mainFormat(), resolution, fps, quality: 'high', includeAudio: true,
      }, () => undefined, new AbortController().signal);
      const sec = (performance.now() - t1) / 1000;
      const seconds = sequenceDuration(store.project) / 705_600_000;
      checks.push({
        name: `Dışa aktarma süresi ${mainFormat().toUpperCase()} ${resolution === '2160' ? '4K' : '1080p'}${fps}`,
        ok: result.phase === 'done',
        detail: `${result.encoder}, ${seconds.toFixed(1)} sn video ${sec.toFixed(1)} sn'de (${(result.total / sec).toFixed(1)} kare/sn), ${((result.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`,
        ms: sec * 1000,
      });
    }
  }

  // Last, because it cuts the project down to the imported clip.
  await aacImport(store, checks);
}

/** Starts of tone bursts: the first sample above `level` after at least `gap` seconds below it. */
function toneStarts(pcm: Float32Array, rate: number, level = 0.1, gap = 0.3): number[] {
  const out: number[] = [];
  let lastLoud = -gap;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) < level) continue;
    const t = i / rate;
    if (t - lastLoud >= gap) out.push(t);
    lastLoud = t;
  }
  return out;
}

/**
 * Times (frame starts) at which the flash square of make-fixture lights up in a video file,
 * searched within `windows`. `lit`: a time known to show the flash; the start of the first window
 * must be dark.
 */
async function flashStarts(url: string, fps: number, windows: Array<[number, number]>, lit: number): Promise<number[]> {
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous';
  v.src = url;
  if (!(await new Promise<boolean>((res) => { v.onloadeddata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(false), 8000); }))) return [];
  const c = document.createElement('canvas');
  c.width = 192; c.height = 108;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const grab = async (t: number) => {
    await new Promise<void>((res) => { v.onseeked = () => res(); v.currentTime = t; setTimeout(res, 2000); });
    g.drawImage(v, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height).data;
  };
  // The square: pixels that change most between a dark frame and a flash frame.
  const dark = await grab(windows[0]![0]);
  const flash = await grab(lit);
  const mask: number[] = [];
  for (let i = 0; i < dark.length; i += 4) if (flash[i]! - dark[i]! > 60) mask.push(i);
  if (!mask.length) return [];
  const out: number[] = [];
  for (const [from, to] of windows) {
    let wasLit = true;
    for (let k = Math.ceil(from * fps); k / fps < to; k++) {
      const d = await grab((k + 0.5) / fps);
      const on = mask.reduce((s, i) => s + d[i]!, 0) / mask.length > 128;
      if (on && !wasLit) { out.push(k / fps); break; }
      wasLit = on;
    }
  }
  return out;
}

/**
 * A phone-like video (H.264 + AAC) added through the real import path, when the smoke run is
 * given one (ZEYVOLA_SMOKE_AAC_FIXTURE): its sound must be decoded by the operating system and
 * kept, stay in sync with the picture, and survive a cut and an export. The fixture has a flash
 * and a 1 kHz tone at 1.0 s and 3.0 s.
 */
async function aacImport(store: EditorStore, checks: Check[]): Promise<void> {
  const projectId = store.project.id;
  const rel = (await window.zeyvola.invoke('smoke:aacFixture', { projectId })) as string | null;
  if (!rel) return;
  const media = (path: string) => store.getState().mediaBase + path.split('/').map(encodeURIComponent).join('/');
  const before = new Set(Object.keys(store.project.recordings));
  const ok = await importVideo(store, () => window.zeyvola.invoke('smoke:pickFile', { projectId, path: rel }) as Promise<PickedFile>);
  const rec = Object.values(store.project.recordings).find((r) => !before.has(r.id));
  const sound = rec?.sources.system;
  const warned = (document.querySelector('.toast')?.textContent ?? '').includes('sesi açılamadı');
  const converted = ok && !!sound && /\/sound\.(m4a|wav)$/.test(sound.file) && !warned;
  checks.push({
    name: 'AAC sesli video (H.264 + AAC): ses işletim sistemiyle çözülüp eklendi, uyarı yok',
    ok: converted,
    detail: sound ? `${sound.file} (${sound.mime}), video ${rec?.sources.screen?.width}×${rec?.sources.screen?.height}` : warned ? 'uyarı gösterildi' : 'ses izi yok',
  });
  if (!converted || !rec || !sound) return;

  // The converted sound: tones where the file has them.
  const decoded = await decodeSound(media(sound.file));
  const tones = toneStarts(decoded.getChannelData(0), decoded.sampleRate);
  const seg = store.project.sequence.segments.find((s) => s.recordingId === rec.id)!;
  const segSeconds = (seg.sourceEnd - seg.sourceStart) / 705_600_000;
  checks.push({
    name: 'AAC sesli video: ses duyulur ve yerinde (ton 1,000 ve 3,000 sn), zaman çizelgesinde süre doğru',
    ok: tones.length === 2 && Math.abs(tones[0]! - 1) < 0.03 && Math.abs(tones[1]! - 3) < 0.03 && Math.abs(segSeconds - 5) < 0.05,
    detail: `tonlar ${tones.map((x) => x.toFixed(3)).join(', ')} sn · ${decoded.numberOfChannels} kanal ${decoded.sampleRate} Hz · bölüm ${segSeconds.toFixed(3)} sn`,
  });

  // Cut the first 0.5 s and export only this clip: flashes and tones move to 0.5 s and 2.5 s together.
  store.apply((p) => {
    let q = trimSegment(p, seg.id, 'start', secondsToTicks(0.5));
    for (const s of q.sequence.segments) if (s.id !== seg.id) q = removeSegment(q, s.id);
    return q;
  });
  const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
    variantId: 'v_16x9', format: mainFormat(), resolution: '1080', fps: 30, quality: 'high', includeAudio: true,
  }, () => undefined, new AbortController().signal);
  let exportOk = false;
  let detail = result.message ?? '';
  if (result.phase === 'done' && result.path) {
    const url = media(exportsRel(result.path));
    const out = await decodeSound(url);
    const t = toneStarts(out.getChannelData(0), out.sampleRate);
    const f = await flashStarts(url, 30, [[0.3, 0.8], [2.3, 2.8]], 0.55);
    const expected = sequenceDuration(store.project) / 705_600_000;
    const near = (xs: number[], ys: number[], tol: number) => xs.length === ys.length && xs.every((x, i) => Math.abs(x - ys[i]!) < tol);
    exportOk = near(t, [0.5, 2.5], 0.03) && near(f, [0.5, 2.5], 0.04) && near(t, f, 0.04) && Math.abs(out.duration - expected) < 0.1;
    detail = `${result.encoder} · süre ${out.duration.toFixed(2)} sn (beklenen ${expected.toFixed(2)}) · ton ${t.map((x) => x.toFixed(3)).join(', ')} · flaş ${f.map((x) => x.toFixed(3)).join(', ')} sn`;
  }
  checks.push({ name: `AAC sesli video: baştan 0,5 sn kesilip ${mainFormat().toUpperCase()} dışa aktarılınca ses ve görüntü birlikte kayar, eşzamanlı kalır`, ok: exportOk, detail });
}

/**
 * A real recording made on this Mac by the native helper (tests/real-capture), when the
 * smoke run is given one (ZEYVOLA_REAL_RECORDING_DIR): open it, check the zoom suggestions
 * against its real clicks, move the camera on its own, hide a region and export.
 */
async function realRecording(checks: Check[], shots: string[]): Promise<void> {
  const { id } = await api.createProject('Gerçek kayıt testi');
  const r = (await window.zeyvola.invoke('smoke:realRecording', { projectId: id })) as { recordingId: string; duration: number } | null;
  if (!r) return;
  window.dispatchEvent(new CustomEvent('zeyvola:smoke-open', { detail: id }));
  const ed = await until(() => {
    const e = (window as unknown as { __zeyvolaEditor?: { store: EditorStore } }).__zeyvolaEditor;
    return e && e.store.project.id === id ? e : null;
  });
  if (!ed) { checks.push({ name: 'Gerçek kayıt: düzenleyici açıldı', ok: false }); return; }
  const store = ed.store;
  const rec = store.project.recordings[r.recordingId]!;
  checks.push({
    name: 'Gerçek kayıt: ekran ve kamera ayrı kaynak olarak açıldı',
    ok: !!rec.sources.screen && !!rec.sources.camera && (rec.capture.backend === 'native-macos' || rec.capture.backend === 'web'),
    detail: `ekran ${rec.sources.screen?.width}×${rec.sources.screen?.height}, kamera ${rec.sources.camera?.width}×${rec.sources.camera?.height}, kaynaklar: ${Object.keys(rec.sources).join(', ')}`,
  });

  // Automatic zoom from the real clicks.
  await until(() => store.project.zooms.length > 0, 12_000);
  const log = await fetch(store.getState().mediaBase + rec.cursorFile!.split('/').map(encodeURIComponent).join('/')).then((x) => x.text());
  const clicks = parseCursorLog(log).clicks.filter((c) => c.kind === 'down');
  const zooms = store.project.zooms.filter((z) => z.recordingId === r.recordingId);
  // A zoom has fully zoomed out at its end, so the end itself is full view.
  const inView = clicks.filter((c) => zooms.some((z) => z.start <= c.t && c.t < z.end && Math.abs(z.center.x - c.x) < 0.4 / z.scale && Math.abs(z.center.y - c.y) < 0.4 / z.scale)).length;
  const fullView = clicks.filter((c) => !zooms.some((z) => z.start <= c.t && c.t < z.end)).length;
  checks.push({
    name: 'Gerçek kayıt: tıklamalardan otomatik zoom önerildi, her tıklama görünür kalır',
    ok: zooms.length > 0 && inView > 0 && inView + fullView === clicks.length,
    detail: `${zooms.length} öneri; ${clicks.length} tıklamanın ${inView} tanesi zoom içinde, ${fullView} tanesi tam görünümde`,
  });

  // Camera moves on its own: the screen view does not change.
  const at = clicks[2]?.t ?? Math.round(r.duration / 2);
  const before = evaluate(store.project, at, { cursors: store.getState().cursors });
  const moved = addCameraMoveAt(store.project, Math.max(0, at - secondsToTicks(1)), { position: { x: 0.5, y: 0.2 }, size: 0.5 }, secondsToTicks(4));
  let cameraOk = false;
  let cameraDetail = 'hareket eklenemedi';
  if (moved) {
    store.apply(() => moved.project);
    const after = evaluate(store.project, at + secondsToTicks(1.5), { cursors: store.getState().cursors });
    const same = evaluate(store.project, at, { cursors: store.getState().cursors });
    cameraOk = !!after.camera && !!before.camera && JSON.stringify(same.screen?.viewport) === JSON.stringify(before.screen?.viewport)
      && Math.abs(after.camera.rect.y - before.camera.rect.y) > 50;
    cameraDetail = `kamera ${before.camera ? `${Math.round(before.camera.rect.x)},${Math.round(before.camera.rect.y)}` : '-'} → ${after.camera ? `${Math.round(after.camera.rect.x)},${Math.round(after.camera.rect.y)}` : '-'}; ekran görünümü değişmedi: ${JSON.stringify(same.screen?.viewport) === JSON.stringify(before.screen?.viewport)}`;
  }
  checks.push({ name: 'Gerçek kayıt: dinamik kamera ekrandan bağımsız hareket eder', ok: cameraOk, detail: cameraDetail });

  // Hide the first target of the test pattern for the whole recording.
  store.apply((p) => addPrivacyCmd(p, {
    recordingId: r.recordingId, start: 0, end: r.duration, origin: 'manual',
    region: { x: 0.14, y: 0.33, w: 0.12, h: 0.18 }, keyframes: [], effect: { kind: 'blur', strength: 1 }, cornerRadius: 0.1, padFrames: 2,
  }).project);
  const hidden = evaluate(store.project, at, { cursors: store.getState().cursors }).privacy.length;
  checks.push({ name: 'Gerçek kayıt: gizleme bölgesi kayıt boyunca etkin', ok: hidden === 1 });
  store.setPlayhead(at);
  await until(() => store.getState().save === 'saved', 5000);
  // No screenshot here: a real recording may show the person in front of the camera.
  void shots;

  const t1 = performance.now();
  const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
    variantId: 'v_16x9', format: usableFormats().includes('mp4') ? 'mp4' : 'webm', resolution: '1080', fps: 30, quality: 'high', includeAudio: true,
  }, () => undefined, new AbortController().signal);
  const ms = performance.now() - t1;
  let ok = result.phase === 'done' && !!result.path;
  let detail = result.message ?? '';
  if (ok && result.path) {
    const rel = exportsRel(result.path);
    const v = document.createElement('video');
    v.muted = true;
    v.crossOrigin = 'anonymous';
    v.src = store.getState().mediaBase + rel.split('/').map(encodeURIComponent).join('/');
    const loaded = await new Promise<boolean>((res) => { v.onloadedmetadata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(false), 8000); });
    const expected = sequenceDuration(store.project) / 705_600_000;
    ok = loaded && Math.abs(v.duration - expected) < 0.2 && v.videoWidth === 1920 && v.videoHeight === 1080;
    detail = `${result.encoder}, ${v.videoWidth}×${v.videoHeight}, ${v.duration.toFixed(2)} sn (beklenen ${expected.toFixed(2)}), ${((result.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB, ${(result.total / (ms / 1000)).toFixed(1)} kare/sn`;
  }
  checks.push({ name: 'Gerçek kayıt: MP4 1080p30 dışa aktarımı (zoom + dinamik kamera + gizleme + ses)', ok, detail, ms });
}

/** Settings → Licenses: the data the screen shows comes from dist/licenses, written by the build. */
async function licenseChecks(checks: Check[]): Promise<void> {
  try {
    const info = await api.licenses();
    const names = info.packages.map((p) => p.name);
    const ok = ['react', 'react-dom', 'scheduler', 'zod'].every((n) => names.includes(n))
      && info.packages.every((p) => p.text.length > 200 && p.license === 'MIT')
      && info.electron.chromiumEntries > 500 && !!info.ownLicense
      && info.codecs.every((c) => c.status === 'legal-review' || c.status === 'low-risk-unverified');
    checks.push({ name: 'Lisanslar: uygulama içi bildirimler paketle birlikte geliyor', ok, detail: `${names.join(', ')} · Electron ${info.electron.version} · ${info.electron.chromiumEntries} Chromium girişi` });
  } catch (e) {
    checks.push({ name: 'Lisanslar: uygulama içi bildirimler paketle birlikte geliyor', ok: false, detail: String(e) });
  }
}

// ─── Export failure paths ─────────────────────────────────────────────────────

/** Opens a project from disk the way the editor does, without the editor. */
async function loadProject(id: string): Promise<{ project: Project; mediaBase: string }> {
  const opened = await api.openProject(id);
  return { project: parseProject(opened.json), mediaBase: opened.mediaBase };
}

/** True when nothing can be read at a project path any more (the media protocol answers 404). */
async function gone(url: string): Promise<boolean> {
  const r = await fetch(url).catch(() => null);
  return !r || !r.ok;
}

/** The file name runExport asks for: "<project> <format name>.<ext>" in exports/. */
const exportPath = (project: Project, ext: string) => `exports/${project.name} ${project.variants.find((v) => v.id === 'v_16x9')!.name.replace(':', 'x')}.${ext}`;

/**
 * A source video that is broken or missing ends the export with "error", a message naming
 * the file, and no file left in exports/ (exporter.ts: ExportMedia.frameAt, export-writer).
 */
async function exportWithBadSource(checks: Check[]): Promise<void> {
  const format = mainFormat();
  const cases: [string, (p: Project, screenFile: string) => Promise<{ project: Project; file: string }>][] = [
    ['bozuk', async (p, screenFile) => {
      // Random bytes in place of the screen video.
      const junk = crypto.getRandomValues(new Uint8Array(64 * 1024));
      await window.zeyvola.invoke('smoke:writeFile', { projectId: p.id, path: screenFile, data: junk });
      return { project: p, file: screenFile.split('/').pop()! };
    }],
    ['eksik', async (p, screenFile) => {
      // The project points at a file that is not on disk (moved or deleted by hand).
      const missing = screenFile.replace(/screen\.(\w+)$/, 'kayip-ekran.$1');
      const rec = Object.values(p.recordings)[0]!;
      const project = { ...p, recordings: { ...p.recordings, [rec.id]: { ...rec, sources: { ...rec.sources, screen: { ...rec.sources.screen!, file: missing } } } } };
      return { project, file: missing.split('/').pop()! };
    }],
  ];
  for (const [kind, spoil] of cases) {
    const name = `Dışa aktarma hatası: ${kind} kaynak videoda "error" ile biter, mesaj dosya adını söyler, exports/ boş kalır`;
    try {
      const sample = await createSampleProject(2, `Kaynak ${kind}`);
      const opened = await loadProject(sample.id);
      const { project, file } = await spoil(opened.project, sample.screenFile);
      const t0 = performance.now();
      const result = await Promise.race([
        routedExport(project, {}, opened.mediaBase, { variantId: 'v_16x9', format, resolution: '1080', fps: 30, quality: 'standard', includeAudio: true }, () => undefined, new AbortController().signal),
        sleep(60_000).then(() => null),
      ]);
      const ms = performance.now() - t0;
      const left = !(await gone(mediaUrl(opened.mediaBase, exportPath(project, format))));
      const ok = !!result && result.phase === 'error' && !!result.message?.includes(file) && !left;
      checks.push({ name, ok, ms, detail: result ? `${result.phase}: "${result.message ?? ''}"${left ? ', yarım dosya exports/ içinde kaldı' : ''}` : '60 sn içinde bitmedi' });
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message });
    }
  }
}

/**
 * The browser takes the export's WebGL context away in the middle (WEBGL_lose_context, as when
 * Chromium drops the oldest of too many contexts). Once: the export draws on a new compositor and
 * finishes with a full picture. Again and again: it stops with a clear message and leaves no file.
 */
async function exportContextLoss(checks: Check[]): Promise<void> {
  const format = mainFormat();
  // Every WebGL2 context the export makes, seen from outside: the app is not changed for this.
  const made: WebGL2RenderingContext[] = [];
  const original = HTMLCanvasElement.prototype.getContext;
  const patched = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement['getContext']>) {
    const ctx = (original as (...a: unknown[]) => unknown).apply(this, args);
    if (args[0] === 'webgl2' && ctx) made.push(ctx as WebGL2RenderingContext);
    return ctx;
  };
  const lose = (gl: WebGL2RenderingContext | undefined) => { if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext(); };

  for (const [kind, total] of [['bir kez', 1], ['sürekli', 99]] as const) {
    const name = kind === 'bir kez'
      ? 'Dışa aktarma sırasında WebGL bağlamı bir kez kaybolunca yeni bağlamla tamamlanır, kareler boş değil'
      : 'Dışa aktarma sırasında WebGL bağlamı sürekli kaybolunca açık bir hatayla durur, dosya bırakmaz';
    try {
      const sample = await createSampleProject(3, `Bağlam kaybı ${kind}`);
      const { project, mediaBase } = await loadProject(sample.id);
      made.length = 0;
      let losses = 0;
      let lostAtFrame = 0;
      HTMLCanvasElement.prototype.getContext = patched as typeof original;
      let result;
      try {
        result = await routedExport(project, {}, mediaBase, { variantId: 'v_16x9', format, resolution: '1080', fps: 30, quality: 'standard', includeAudio: true }, (pr) => {
          if (pr.phase !== 'video' || pr.frame < 10 || losses >= total) return;
          lose(made[made.length - 1]);
          losses++;
          lostAtFrame ||= pr.frame;
        }, new AbortController().signal);
      } finally {
        HTMLCanvasElement.prototype.getContext = original;
      }
      const url = mediaUrl(mediaBase, exportPath(project, format));
      const seconds = sequenceDuration(project) / 705_600_000;
      if (kind === 'bir kez') {
        // Frames right after the loss and the last one must show the picture, not a blank canvas.
        const after = await probeVideo(url, (lostAtFrame + 2) / 30);
        const last = await probeVideo(url, seconds - 0.05);
        // Also proves that `gone` and exportPath find a written export (the other checks rely on it).
        const found = !(await gone(url));
        const ok = found && result.phase === 'done' && losses === 1 && made.length >= 2 && Math.abs(after.duration - seconds) < 0.15 && after.spread > 0.02 && last.spread > 0.02;
        checks.push({ name, ok, detail: `${result.phase}${result.message ? `: ${result.message}` : ''}${found ? '' : ', dosya exports/ içinde bulunamadı'}; ${losses} kayıp (${lostAtFrame}. kare), ${made.length} bağlam açıldı, kayıptan sonraki kare yayılımı ${after.spread.toFixed(3)}, son kare ${last.spread.toFixed(3)}, ${after.duration.toFixed(2)} sn` });
      } else {
        const left = !(await gone(url));
        const ok = result.phase === 'error' && !!result.message && !left;
        checks.push({ name, ok, detail: `${result.phase}: "${result.message ?? ''}" · ${losses} kayıp, ${made.length} bağlam${left ? ', dosya exports/ içinde kaldı' : ''}` });
      }
    } catch (e) {
      HTMLCanvasElement.prototype.getContext = original;
      checks.push({ name, ok: false, detail: (e as Error).message });
    }
  }
}

export async function runSmokeTests(): Promise<unknown> {
  const checks: Check[] = [];
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'bilinmiyor';
  checks.push({ name: 'WebGL2 kullanılabilir', ok: !!gl, detail: gpu });
  try { await privacyChecks(checks); } catch (e) { checks.push({ name: 'Gizlilik testleri', ok: false, detail: (e as Error).message }); }
  try { await magnifierChecks(checks); } catch (e) { checks.push({ name: 'Büyüteç testleri', ok: false, detail: (e as Error).message }); }
  try { await contextLifetime(checks); } catch (e) { checks.push({ name: 'WebGL bağlam ömrü', ok: false, detail: (e as Error).message }); }
  if (PROFILE.formats.includes('mp4')) {
    try { await mp4Support(checks); } catch (e) { checks.push({ name: 'MP4 desteği sorusu', ok: false, detail: (e as Error).message }); }
  }
  for (const format of roundTripFormats()) await roundTrip(format, checks);
  await licenseChecks(checks);
  zoomPerf(checks);
  const capabilities = await codecMatrix();
  // Camera warm-up against Chromium's fake camera (enabled only in --smoke mode).
  try {
    const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    const ms = await warmUpCamera(cam, 3000);
    const v = document.createElement('video');
    v.muted = true;
    v.srcObject = cam;
    await v.play();
    await sleep(100);
    const c = document.createElement('canvas');
    c.width = 16; c.height = 9;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, 16, 9);
    const d = g.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
    const luma = sum / (16 * 9 * 3 * 255);
    for (const t of cam.getTracks()) t.stop();
    checks.push({ name: 'Kamera ısınması: kayıt siyah olmayan, oturmuş görüntüyle başlar', ok: luma > 0.03 && ms < 3100, detail: `ısınma ${ms.toFixed(0)} ms, ilk kare parlaklığı ${(luma * 100).toFixed(0)}%` });
  } catch (e) {
    checks.push({ name: 'Kamera ısınması', ok: false, detail: (e as Error).message });
  }
  const shots: string[] = [];
  try { await endToEnd(checks, shots); } catch (e) { checks.push({ name: 'Uçtan uca akış', ok: false, detail: (e as Error).stack ?? String(e) }); }
  try { await realRecording(checks, shots); } catch (e) { checks.push({ name: 'Gerçek kayıt akışı', ok: false, detail: (e as Error).stack ?? String(e) }); }
  await exportWithBadSource(checks);
  await exportContextLoss(checks);
  return { ok: checks.every((c) => c.ok), gpu, checks, capabilities, shots, userAgent: navigator.userAgent, webCodecsH264, mp4Route, ...(mp4Missing ? { mp4Missing } : {}) };
}

/** What tests/media-check reports through smoke:avCheck (AVFoundation or Media Foundation). */
interface SystemProbe {
  ok: boolean;
  skipped?: boolean;
  engine?: string;
  problems: string[];
  duration: number;
  video: { width?: number; height?: number } | null;
}
