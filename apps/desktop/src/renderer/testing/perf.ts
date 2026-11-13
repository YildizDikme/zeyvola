/**
 * Performance test (`pnpm perftest`). Runs the real editor on sample recordings and measures
 * what a user feels: how long automatic zoom takes, how evenly the preview plays through zooms,
 * how fast the playhead answers when it is moved, and how long an export takes. Each number
 * comes with CPU use and totals, so two runs (before / after a change) can be compared.
 *
 * Two sample recordings with the same made-up content:
 *   - "tarayıcı kaydı": recorded in real time with MediaRecorder (WebM without duration or seek
 *     index, few frames while the picture stands still), like the Chromium recording path;
 *   - "düzenli dosya": 30 fps files written by our own muxer, like the macOS recorder's.
 */
import { parseCursorLog, presetTransition, sequenceDuration, type CursorTrack } from '@zeyvola/project-model';
import { TICKS_PER_SECOND, secondsToTicks } from '@zeyvola/timing';
import { suggestZooms } from '@zeyvola/zoom-engine';
import { PROFILE, DIST } from '../../shared/distribution';
import type { ExportOptions } from '../export/exporter';
import { probe } from '../perf-probe';
import { regenerateZoomSuggestions } from '../screens/editor/zoom-actions';
import { recordLikeBrowser, synthesizeRecording } from '../smoke-fixtures';
import { api } from '../api';
import { cpuNow, cpuPercent, createSampleProject, exportsRel, frame, invoke, openInEditor, routedExport, sleep, stats, until, type Check, type OpenEditor, type SampleProject } from './harness';

/** One measured number. `better` says which direction is an improvement, for comparisons. */
export interface Metric { name: string; value: number; unit: string; better?: 'lower' | 'higher' }
export interface Scenario { name: string; metrics: Metric[]; note?: string }

const m = (name: string, value: number, unit: string, better?: 'lower' | 'higher'): Metric => ({ name, value: Math.round(value * 100) / 100, unit, ...(better ? { better } : {}) });

// ─── Automatic zoom ───────────────────────────────────────────────────────────

/** One hour of pointer samples with a click every 4 s: the zoom engine alone. */
async function zoomEngineScenario(): Promise<Scenario> {
  const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let x = 0.5;
  let y = 0.5;
  for (let i = 0; i < 3600 * 60; i++) {
    const s = i / 60;
    if (i % 240 === 0) {
      x = 0.05 + rnd() * 0.9;
      y = 0.05 + rnd() * 0.9;
      track.clicks.push({ t: secondsToTicks(s), x, y, button: 'left', kind: 'down' });
      track.clicks.push({ t: secondsToTicks(s + 0.09), x, y, button: 'left', kind: 'up' });
    }
    track.samples.push({ t: secondsToTicks(s), x, y });
  }
  const times: number[] = [];
  let count = 0;
  const c0 = await cpuNow();
  const all0 = performance.now();
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    count = suggestZooms({ recordingId: 'r', duration: secondsToTicks(3600), track, hasClicks: true, sensitivity: 'medium', defaults: { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') } }).length;
    times.push(performance.now() - t0);
  }
  const total = performance.now() - all0;
  const c1 = await cpuNow();
  const st = stats(times);
  return {
    name: 'Otomatik zoom · motor (1 saatlik imleç kaydı, 900 tıklama)',
    note: '5 tekrar',
    metrics: [
      m('öneri süresi (ortanca)', st.p50, 'ms', 'lower'), m('öneri süresi (en uzun)', st.max, 'ms', 'lower'), m('öneri sayısı', count, 'adet'),
      m('toplam süre (5 tekrar)', total, 'ms', 'lower'), m('CPU', cpuPercent(c0, c1), '% çekirdek', 'lower'),
    ],
  };
}

/** "Otomatik zoom" in the open editor: read the log, run the engine, apply, redraw. */
async function zoomInEditorScenario(ed: OpenEditor, label: string): Promise<Scenario> {
  const times: number[] = [];
  let count = 0;
  // Frame intervals while it runs: a long one is a stall the user sees in the editor.
  const intervals: number[] = [];
  let last = 0;
  let running = true;
  const tick = (ts: number) => {
    if (!running) return;
    if (last) intervals.push(ts - last);
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await frame();
  const c0 = await cpuNow();
  const all0 = performance.now();
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    count = await regenerateZoomSuggestions(ed.store);
    await frame();
    await frame();
    times.push(performance.now() - t0);
  }
  const total = performance.now() - all0;
  const c1 = await cpuNow();
  running = false;
  const st = stats(times);
  const iv = stats(intervals);
  return {
    name: `Otomatik zoom · düzenleyicide (${label})`,
    note: '5 tekrar',
    metrics: [
      m('yeniden öner + çiz (ortanca)', st.p50, 'ms', 'lower'), m('yeniden öner + çiz (en uzun)', st.max, 'ms', 'lower'), m('öneri sayısı', count, 'adet'),
      m('kare süresi (ortanca)', iv.p50, 'ms', 'lower'), m('kare süresi (en uzun)', iv.max, 'ms', 'lower'),
      m('toplam süre (5 tekrar)', total, 'ms', 'lower'), m('CPU', cpuPercent(c0, c1), '% çekirdek', 'lower'),
    ],
  };
}

// ─── Playback through zooms ───────────────────────────────────────────────────

async function playbackScenario(ed: OpenEditor, sample: SampleProject, label: string, checks: Check[]): Promise<Scenario> {
  const { store, player } = ed;
  const media = player.elementsFor(sample.recordingId);
  const screen = media?.screen;
  store.setPlayhead(0);
  await sleep(800);
  const seeks: Record<string, number> = { screen: 0, camera: 0, mic: 0 };
  let stalls = 0;
  const onStall = () => { stalls++; };
  const watched = (['screen', 'camera', 'mic'] as const).flatMap((kind) => {
    const el = media?.[kind];
    if (!el) return [];
    const onSeek = () => { seeks[kind]!++; };
    el.addEventListener('seeking', onSeek);
    el.addEventListener('waiting', onStall);
    return [{ el, onSeek }];
  });
  const intervals: number[] = [];
  const drift: number[] = [];
  let last = 0;
  let running = true;
  const tick = (ts: number) => {
    if (!running) return;
    if (last) intervals.push(ts - last);
    last = ts;
    // The sample is one uncut recording starting at 0, so media time equals timeline time.
    if (screen && store.getState().playing) drift.push(Math.abs(screen.currentTime - store.getState().playhead / TICKS_PER_SECOND) * 1000);
    requestAnimationFrame(tick);
  };
  const q0 = screen?.getVideoPlaybackQuality();
  probe.start();
  const c0 = await cpuNow();
  const t0 = performance.now();
  player.play();
  requestAnimationFrame(tick);
  const ended = await until(() => !store.getState().playing, 60_000, 50);
  const wall = performance.now() - t0;
  const length = sequenceDuration(store.project) / TICKS_PER_SECOND;
  checks.push({ name: `Önizleme sonuna kadar oynadı (${label})`, ok: !!ended && wall / 1000 > length * 0.9, detail: `${length.toFixed(2)} sn çizelge ${(wall / 1000).toFixed(2)} sn'de oynadı` });
  running = false;
  const c1 = await cpuNow();
  const pr = probe.stop();
  const q1 = screen?.getVideoPlaybackQuality();
  for (const w of watched) {
    w.el.removeEventListener('seeking', w.onSeek);
    w.el.removeEventListener('waiting', onStall);
  }
  const iv = stats(intervals);
  const refresh = iv.p50 || 16.67;
  const long = intervals.filter((v) => v > refresh * 1.5).length;
  const draw = stats(pr.series['preview-draw'] ?? []);
  const dr = stats(drift);
  return {
    name: `Önizleme oynatma · zoom'larla (${label})`,
    note: `ekran yenileme aralığı ≈ ${refresh.toFixed(1)} ms`,
    metrics: [
      m('oynatma süresi', wall / 1000, 'sn'),
      m('kare aralığı (ortanca)', iv.p50, 'ms', 'lower'),
      m('kare aralığı (%95)', iv.p95, 'ms', 'lower'),
      m('kare aralığı (en uzun)', iv.max, 'ms', 'lower'),
      m('geciken kare (>1,5× aralık)', long, 'adet', 'lower'),
      m('önizleme çizimi (ortanca)', draw.p50, 'ms', 'lower'),
      m('önizleme çizimi (%95)', draw.p95, 'ms', 'lower'),
      m('yeniden konumlama: ekran', seeks.screen!, 'adet', 'lower'),
      m('yeniden konumlama: kamera', seeks.camera!, 'adet', 'lower'),
      m('yeniden konumlama: ses', seeks.mic!, 'adet', 'lower'),
      m('oynatma beklemesi', stalls, 'adet', 'lower'),
      m('görüntü–saat farkı (ortanca)', dr.p50, 'ms', 'lower'),
      m('görüntü–saat farkı (%95)', dr.p95, 'ms', 'lower'),
      m('atlanan video karesi', (q1?.droppedVideoFrames ?? 0) - (q0?.droppedVideoFrames ?? 0), 'adet', 'lower'),
      m('React çizimi: Editor', pr.counts['react:Editor'] ?? 0, 'adet', 'lower'),
      m('React çizimi: Timeline', pr.counts['react:Timeline'] ?? 0, 'adet', 'lower'),
      m('React çizimi: Inspector', pr.counts['react:Inspector'] ?? 0, 'adet', 'lower'),
      m('CPU', cpuPercent(c0, c1), '% çekirdek', 'lower'),
    ],
  };
}

/** Moving the playhead (paused): time until the picture of the new moment is on screen. */
async function scrubScenario(ed: OpenEditor, sample: SampleProject, label: string): Promise<Scenario> {
  const { store, player } = ed;
  const screen = player.elementsFor(sample.recordingId)?.screen;
  const duration = sequenceDuration(store.project) / TICKS_PER_SECOND;
  const times: number[] = [];
  let missed = 0;
  const c0 = await cpuNow();
  for (let i = 0; i < 24; i++) {
    // Forward steps, then jumps back and forth, like dragging and clicking on the timeline.
    const sec = i < 12 ? 0.3 + (i * (duration - 0.6)) / 12 : (i % 2 ? 0.15 : 0.85) * duration - (i - 12) * 0.05;
    const t0 = performance.now();
    store.setPlayhead(secondsToTicks(sec));
    const ok = await until(() => !!screen && !screen.seeking && Math.abs(screen.currentTime - sec) < 0.05, 5000, 4);
    await frame();
    if (ok) times.push(performance.now() - t0);
    else missed++;
  }
  const c1 = await cpuNow();
  const st = stats(times);
  return {
    name: `Oynatma imlecini taşıma (${label})`,
    metrics: [
      m('yeni an ekranda (ortanca)', st.p50, 'ms', 'lower'), m('yeni an ekranda (%95)', st.p95, 'ms', 'lower'), m('yeni an ekranda (en uzun)', st.max, 'ms', 'lower'),
      m('5 sn içinde gelmeyen', missed, 'adet', 'lower'), m('CPU', cpuPercent(c0, c1), '% çekirdek', 'lower'),
    ],
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

async function exportScenario(ed: OpenEditor, label: string, o: Pick<ExportOptions, 'format' | 'resolution' | 'fps'>, checks: Check[]): Promise<Scenario> {
  const { store } = ed;
  const seconds = sequenceDuration(store.project) / TICKS_PER_SECOND;
  const name = `Dışa aktarma · ${o.format.toUpperCase()} ${o.resolution === '2160' ? '4K' : '1080p'}${o.fps} (${label})`;
  probe.start();
  const c0 = await cpuNow();
  const t0 = performance.now();
  const result = await routedExport(store.project, store.getState().cursors, store.getState().mediaBase, {
    variantId: 'v_16x9', quality: 'high', includeAudio: true, ...o,
  }, () => undefined, new AbortController().signal);
  const wall = (performance.now() - t0) / 1000;
  const c1 = await cpuNow();
  const pr = probe.stop();
  // The written file must open and have the timeline's length.
  let played = Number.NaN;
  if (result.phase === 'done' && result.path) {
    const rel = exportsRel(result.path);
    const v = document.createElement('video');
    v.muted = true;
    v.src = store.getState().mediaBase + rel.split('/').map(encodeURIComponent).join('/');
    await new Promise<void>((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 8000); });
    played = v.duration;
    v.removeAttribute('src');
    v.load();
  }
  const ok = result.phase === 'done' && Math.abs(played - seconds) < 0.25;
  checks.push({ name, ok, detail: ok ? `${result.encoder}, ${played.toFixed(2)} sn` : `${result.phase}: ${result.message ?? `dosya süresi ${played} sn, beklenen ${seconds.toFixed(2)} sn`}` });
  const per = stats(pr.series['export-frame'] ?? []);
  const src = stats(pr.series['export-source'] ?? []);
  const draw = stats(pr.series['export-draw'] ?? []);
  const enc = stats(pr.series['export-encode-wait'] ?? []);
  return {
    name,
    note: result.encoder,
    metrics: [
      m('toplam süre', wall, 'sn', 'lower'),
      m('hız', result.total / wall, 'kare/sn', 'higher'),
      m('gerçek zamana oran', seconds / wall, '×', 'higher'),
      m('kare süresi (ortanca)', per.p50, 'ms', 'lower'),
      m('kare süresi (%95)', per.p95, 'ms', 'lower'),
      m('kare süresi (en uzun)', per.max, 'ms', 'lower'),
      m('kaynak kareyi getirme (ortalama)', src.mean, 'ms', 'lower'),
      m('çizim (ortalama)', draw.mean, 'ms', 'lower'),
      m('kodlayıcıyı bekleme (ortalama)', enc.mean, 'ms', 'lower'),
      m('CPU', cpuPercent(c0, c1), '% çekirdek', 'lower'),
      m('CPU süresi', c1.seconds - c0.seconds, 'sn', 'lower'),
      m('dosya boyutu', (result.bytes ?? 0) / 1024 / 1024, 'MB'),
    ],
  };
}

async function realSample(): Promise<SampleProject | null> {
  const { id } = await api.createProject('Performans testi (gerçek kayıt)');
  const r = await invoke<{ recordingId: string } | null>('smoke:realRecording', { projectId: id });
  return r ? { id, recordingId: r.recordingId, screenFile: '', recording: null } : null;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

export async function runPerfTests(): Promise<unknown> {
  const checks: Check[] = [];
  const scenarios: Scenario[] = [];
  const started = performance.now();
  const gl = document.createElement('canvas').getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const gpu = gl && dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'bilinmiyor';

  try {
    scenarios.push(await zoomEngineScenario());
    const samples: [string, (s: number) => Promise<Awaited<ReturnType<typeof synthesizeRecording>>>][] = [
      ['tarayıcı kaydı', recordLikeBrowser],
      ['düzenli dosya', synthesizeRecording],
    ];
    // Optional, for looking into one's own recording: ZEYVOLA_REAL_RECORDING_DIR=<folder with the
    // recording's files and recording.json>. It is copied into the temporary project.
    const real = await realSample();
    for (const [label, make] of [...samples, ...(real ? [['gerçek kayıt', null] as const] : [])]) {
      const sample = make ? await createSampleProject(8, `Performans testi (${label})`, make) : real!;
      const ed = await openInEditor(sample.id);
      if (!ed) { checks.push({ name: `Düzenleyici açıldı (${label})`, ok: false }); continue; }
      const zooms = await until(() => ed.store.project.zooms.length > 0 && ed.store.project.zooms.length, 12_000);
      const clicks = parseCursorLog(sample.recording?.cursorLog ?? '').clicks.filter((c) => c.kind === 'down').length;
      checks.push({ name: `Otomatik zoom önerileri oluştu (${label})`, ok: !!zooms, detail: `${clicks} tıklamadan ${zooms ?? 0} öneri` });
      await until(() => ed.store.getState().save === 'saved', 5000);
      scenarios.push(await zoomInEditorScenario(ed, label));
      scenarios.push(await playbackScenario(ed, sample, label, checks));
      scenarios.push(await scrubScenario(ed, sample, label));
      const format = PROFILE.defaultExport;
      scenarios.push(await exportScenario(ed, label, { format, resolution: '1080', fps: 30 }, checks));
      scenarios.push(await exportScenario(ed, label, { format, resolution: '1080', fps: 60 }, checks));
    }
  } catch (e) {
    checks.push({ name: 'Performans testi', ok: false, detail: (e as Error).stack ?? String(e) });
  }
  return {
    suite: 'perf', ok: checks.every((c) => c.ok), checks, scenarios, gpu, dist: DIST,
    totalSeconds: Math.round((performance.now() - started) / 100) / 10, userAgent: navigator.userAgent,
  };
}
