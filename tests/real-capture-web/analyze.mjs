#!/usr/bin/env node
// Compares a real recording made by the packaged app (browser recording path, distribution B)
// with what the test pattern logged.
//
//   node tests/real-capture-web/analyze.mjs --home <ZEYVOLA_TEST_HOME> --pattern <pattern.jsonl>
//        [--probe <chromium-probe result.json>] [--recording <id>] [--pause <s>:<length s>] [--out <result.json>]
//   node tests/real-capture-web/analyze.mjs --home <…> --pattern <…> --probe-args
//        prints the chromium-probe arguments for this recording (screen video regions, microphone)
//
// Clicks: every click the pattern saw must be in the app's cursor log with the same button, at
// the same place (normalized to the recorded region). Time: the target the pattern turns white on
// each click must appear in the screen video when the click plus the pattern's own drawing time
// says (Event Timing: the input's time and when the next frame reached the screen), ±20 ms.
// Recording time is the app's clock (session.jsonl: start, pauses); the pattern's times are mapped
// onto it, pauses removed. Recordings made before pauses were logged take --pause.
// Zoom: each left click lies inside an automatic zoom whose view contains it, or in full view.
// Sync: microphone tones (the pattern beeps with each flash) against the flashes in the video, and
// against the time the beep left the speaker (the page's audio output timestamp).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const home = opt('--home');
const patternFile = opt('--pattern');
if (!home || !patternFile) { console.error('Kullanım: analyze.mjs --home <klasör> --pattern <desen.jsonl> [--probe <ölçüm.json>] [--recording <id>] [--pause <sn>:<süre sn>] [--out <sonuç.json>] | --probe-args'); process.exit(2); }
const TICKS = 705_600_000;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const jsonl = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The newest web recording in the test home (or the one asked for).
const projects = readdirSync(join(home, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(home, 'projects', d.name, 'project.json')))
  .map((d) => ({ dir: join(home, 'projects', d.name), project: JSON.parse(readFileSync(join(home, 'projects', d.name, 'project.json'), 'utf8')) }));
const all = projects.flatMap(({ dir, project }) => Object.values(project.recordings).map((rec) => ({ dir, project, rec })));
const pick = opt('--recording') ? all.find((x) => x.rec.id === opt('--recording')) : all.filter((x) => x.rec.capture?.backend === 'web').sort((a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt)).pop();
if (!pick) { console.error('Kayıt bulunamadı'); process.exit(1); }
const { dir, project, rec } = pick;
const mediaDir = join(dir, dirname(rec.sources.screen.file));

const pattern = jsonl(patternFile);
const session = jsonl(join(mediaDir, 'session.jsonl'));
const startedAt = session.find((e) => e.e === 'session')?.startedAtMs ?? null;
const region = rec.capture.target.bounds; // screen points, what the recording shows
const isWindow = rec.capture.target.kind === 'window';
const startOffset = (k) => (rec.sources[k]?.startOffset ?? 0) / TICKS;

// ─── Where the pattern's parts are in the screen video ──────────────────────
// Fractions of the pattern's content area: the sync square, and for each target a box above and
// left of its center (the cursor, baked into the video, sits at the center and below it).
const boundsAt = (ms) => [...pattern].filter((e) => e.type === 'bounds' && e.epochMs <= ms).pop() ?? pattern.find((e) => e.type === 'bounds');
const TARGETS = [[0.2, 0.42], [0.5, 0.42], [0.8, 0.42], [0.2, 0.72], [0.5, 0.72], [0.8, 0.72]];
function videoRegions() {
  const b = boundsAt(startedAt ?? Infinity);
  const c = b.content;
  // A window recording shows the window (title bar included) wherever it is; a display or region
  // recording shows the whole display (the region is a crop of it).
  const frame = isWindow ? { x: b.window.x, y: b.window.y, w: b.window.width, h: b.window.height } : { x: b.display.bounds.x, y: b.display.bounds.y, w: b.display.bounds.width, h: b.display.bounds.height };
  const box = (x, y, w, h) => [(c.x + x - frame.x) / frame.w, (c.y + y - frame.y) / frame.h, w / frame.w, h / frame.h].map((v) => Math.round(v * 1e5) / 1e5);
  return [box(0.89 * c.width, 0.05 * c.height, 0.08 * c.width, 0.12 * c.height), ...TARGETS.map(([tx, ty]) => box(tx * c.width - 30, ty * c.height - 30, 18, 18))];
}
if (argv.includes('--probe-args')) {
  const files = [`${join(dir, rec.sources.screen.file)}:${videoRegions().map((r) => r.join(',')).join(';')}`];
  if (rec.sources.mic) files.push(join(dir, rec.sources.mic.file));
  console.log(files.map((f) => JSON.stringify(f)).join(' '));
  process.exit(0);
}

// ─── Recording clock ────────────────────────────────────────────────────────
// Paused intervals in epoch ms, from the session log or (older recordings) --pause.
const pauses = [];
for (const e of session) {
  if (e.e === 'pause') pauses.push({ from: e.atMs, to: null });
  if (e.e === 'resume' && pauses.length && pauses[pauses.length - 1].to === null) pauses[pauses.length - 1].to = e.atMs;
}
if (!pauses.length && opt('--pause') && startedAt !== null) {
  const [at, len] = opt('--pause').split(':').map(Number);
  pauses.push({ from: startedAt + at * 1000, to: startedAt + (at + len) * 1000 });
}
/** Recording time (s) of an epoch time; null while paused or before the start. */
const sessionOf = (ms) => {
  if (startedAt === null || ms < startedAt) return null;
  let paused = 0;
  for (const p of pauses) {
    if (ms >= p.from && (p.to === null || ms < p.to)) return null;
    if (p.to !== null && ms >= p.to) paused += p.to - p.from;
  }
  return (ms - startedAt - paused) / 1000;
};

const result = {
  recording: {
    id: rec.id, project: project.name, target: rec.capture.target.kind, region, durationS: r3(rec.duration / TICKS), hasClicks: rec.capture.hasClicks,
    pauses: pauses.map((p) => ({ atS: r3(sessionOf(p.from - 0.001) ?? 0), lengthS: p.to === null ? null : r3((p.to - p.from) / 1000) })),
    sources: Object.fromEntries(Object.entries(rec.sources).map(([k, s]) => [k, { file: s.file, mime: s.mime, w: s.width, h: s.height, fps: s.fps, startOffsetS: r3(s.startOffset / TICKS), durationS: r3(s.duration / TICKS) }])),
    tracks: session.filter((e) => e.e === 'track').map(({ e: _e, ...t }) => t),
  },
  checks: [],
};
const check = (name, ok, detail) => result.checks.push({ name, ok, detail });
if (startedAt === null) check('Oturum günlüğü (session.jsonl) okundu', false, 'kayıt saati bilinmiyor; zaman ölçümleri yapılamaz');

// ─── Cursor log ─────────────────────────────────────────────────────────────
const log = rec.cursorFile ? jsonl(join(dir, rec.cursorFile)) : [];
const moves = log.filter((e) => e.e === 'm');
// Clicks inside the recorded area (the log also keeps clicks elsewhere on the screen).
const downs = log.filter((e) => e.e === 'd' && e.x >= 0 && e.x <= 1 && e.y >= 0 && e.y <= 1);
const pClicks = pattern.filter((e) => e.type === 'click');
const rate = moves.length > 1 ? (moves.length - 1) / ((moves[moves.length - 1].t - moves[0].t) / TICKS) : 0;
check('İmleç konumu kayıt boyunca yazıldı (~60 Hz)', moves.length > 0 && rate > 50, `${moves.length} örnek, ${rate.toFixed(1)} Hz`);
// Each pattern click with the cursor-log click at the same moment (±100 ms; by order without a clock).
const pairs = pClicks.map((c, i) => {
  const s = sessionOf(c.epochMs);
  const d = s === null ? (startedAt === null ? downs[i] : undefined) : downs.find((x) => Math.abs(x.t / TICKS - s) < 0.1);
  return d ? { c, d } : null;
});
check('Desenin gördüğü her tıklama imleç günlüğünde (sayı ve düğme)', pairs.every((p) => p && (p.d.b === 'r') === (p.c.button === 2)) && downs.length === pClicks.length,
  `desen ${pClicks.length} (${pClicks.filter((c) => c.button === 2).length} sağ), kayıt ${downs.length} (${downs.filter((d) => d.b === 'r').length} sağ), eşleşen ${pairs.filter(Boolean).length}`);
const matched = pairs.filter(Boolean);

// Place: the pattern's click (fraction of its content area) mapped into the recorded area. For a
// window recording that area is the window itself, wherever it was at the moment of the click.
if (matched.length) {
  const errs = matched.map(({ c: pc, d }) => {
    const b = boundsAt(pc.epochMs);
    const c = b.content;
    const area = isWindow ? { x: b.window.x, y: b.window.y, w: b.window.width, h: b.window.height } : region;
    const ex = (c.x + pc.x * c.width - area.x) / area.w;
    const ey = (c.y + pc.y * c.height - area.y) / area.h;
    return { dx: d.x - ex, dy: d.y - ey, px: Math.hypot((d.x - ex) * area.w, (d.y - ey) * area.h), area };
  });
  if (isWindow) result.windowPositions = [...new Set(errs.map((e) => `${e.area.x},${e.area.y}`))].length;
  const worst = Math.max(...errs.map((e) => e.px));
  check(isWindow ? 'Tıklama konumu doğru (o andaki pencereye göre)' : 'Tıklama konumu doğru (bölgeye göre)', worst <= 2, `en büyük sapma ${worst.toFixed(2)} pt, ortanca ${median(errs.map((e) => e.px)).toFixed(2)} pt`);
  result.clickPlaces = errs.map((e) => ({ dxPt: r3(e.dx * e.area.w), dyPt: r3(e.dy * e.area.h) }));
}

// ─── Screen video against the pattern ───────────────────────────────────────
const probe = opt('--probe') ? JSON.parse(readFileSync(opt('--probe'), 'utf8')) : null;
const screenProbe = probe?.results?.find((x) => x.kind === 'video' && x.file.includes(rec.sources.screen?.file?.split('/').pop() ?? '\0'));
const micProbe = probe?.results?.find((x) => x.kind === 'audio' && rec.sources.mic && x.file.includes(rec.sources.mic.file.split('/').pop()));
const near = (x, xs) => xs.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
const flashes = pattern.filter((e) => e.type === 'flash').map((e) => ({ s: sessionOf(e.frameEpochMs ?? e.epochMs), beep: e.beepEpochMs != null ? sessionOf(e.beepEpochMs) : null })).filter((f) => f.s !== null);

// Flashes: when the video shows each one against when the pattern drew it (its drawing time included).
let flashLate = null;
if (screenProbe?.rises?.length && flashes.length) {
  const res = screenProbe.rises.map((v) => { const s = v + startOffset('screen'); return s - near(s, flashes.map((f) => f.s)); });
  flashLate = median(res);
  const spread = Math.max(...res) - Math.min(...res);
  check('Görüntüdeki flaşlar desenle tutarlı (kare zamanları kaymıyor)', spread < 0.05, `${res.length} flaş, sapma aralığı ${(spread * 1000).toFixed(1)} ms; görüntü desenin çizdiği andan ortanca ${(flashLate * 1000).toFixed(1)} ms sonra (desenin çizim süresi dahil)`);
  result.flashLateMs = res.map((x) => r1(x * 1000));
}

// Clicks against the video. Expected: the click (cursor log, app clock) plus the pattern's time
// from input to the frame showing the white target (Event Timing). Seen: that target's rise.
const timings = pattern.filter((e) => e.type === 'eventTiming');
const targetRises = screenProbe?.regions?.slice(1);
if (matched.length && targetRises?.length === 6) {
  // A click without its own entry (Chromium logs none for a right click) gets the others' drawing time.
  const ORDER = ['mousedown', 'pointerdown', 'contextmenu'];
  const timingOf = (c) => timings.filter((e) => ORDER.includes(e.name) && Math.abs(e.inputEpochMs - c.epochMs) < 50).sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))[0];
  const typicalDraw = median(matched.map(({ c }) => timingOf(c)?.durationMs).filter((x) => x != null));
  const rows = matched.map(({ c, d }) => {
    const et = timingOf(c);
    const drawMs = et?.durationMs ?? typicalDraw;
    if (!c.target || drawMs == null) return { target: c.target, error: c.target ? 'Event Timing yok' : 'hedef dışı' };
    const expected = d.t / TICKS + drawMs / 1000;
    const seen = targetRises[c.target - 1].rises.map((v) => v + startOffset('screen')).filter((s) => s > expected - 0.3 && s < expected + 0.5);
    if (!seen.length) return { target: c.target, error: 'görüntüde beyaz hedef bulunamadı' };
    // The same, from the pattern's own clock: when its frame reached the screen.
    const present = et ? sessionOf(et.presentEpochMs) : null;
    return { target: c.target, drawMs: r1(drawMs), ...(et ? {} : { drawFromOtherClicks: true }), ms: r1((seen[0] - expected) * 1000), vsPatternMs: present === null ? null : r1((seen[0] - present) * 1000), inputVsLogMs: et && sessionOf(et.inputEpochMs) !== null ? r1((sessionOf(et.inputEpochMs) - d.t / TICKS) * 1000) : null };
  });
  result.clickVsVideo = rows;
  const ok = rows.filter((r) => r.ms != null);
  check('Tıklama ile görüntüdeki tepkisi ±20 ms (desenin çizim süresi hariç)', ok.length === rows.length && ok.every((r) => Math.abs(r.ms) <= 20),
    ok.length ? `${ok.length}/${rows.length} tıklama (${ok.filter((r) => r.drawFromOtherClicks).length} tanesinde çizim süresi diğerlerinden); ortanca ${median(ok.map((r) => r.ms)).toFixed(1)} ms, en büyük ${Math.max(...ok.map((r) => Math.abs(r.ms))).toFixed(1)} ms (artı: görüntü geç); desenin çizim süresi ${median(ok.map((r) => r.drawMs))} ms` : rows.map((r) => r.error).join(', '));
}

// The same against the flashes, as before Event Timing was logged (drawing time included).
if (matched.length && flashLate !== null) {
  const errs = matched.map(({ c, d }) => { const s = sessionOf(c.epochMs); return s === null ? null : (d.t / TICKS - (s + flashLate)) * 1000; }).filter((x) => x !== null);
  result.clickTimesMs = errs.map((e) => Math.round(e));
  check('Tıklama zamanı flaşlara göre ±50 ms (desenin çizim süresi dahil)', errs.every((e) => Math.abs(e) <= 50), `ortanca ${median(errs).toFixed(1)} ms, en büyük ${Math.max(...errs.map(Math.abs)).toFixed(1)} ms (artı: kayıtta geç)`);
}

// ─── Automatic zoom from the clicks ─────────────────────────────────────────
const zooms = project.zooms.filter((z) => z.recordingId === rec.id);
const lefts = downs.filter((d) => d.b !== 'r');
const inView = lefts.filter((c) => zooms.some((z) => z.start <= c.t && c.t < z.end && Math.abs(z.center.x - c.x) < 0.4 / z.scale && Math.abs(z.center.y - c.y) < 0.4 / z.scale)).length;
const fullView = lefts.filter((c) => !zooms.some((z) => z.start <= c.t && c.t < z.end)).length;
check('Otomatik zoom: sol tıklamalardan öneri var, her tıklama görünür kalır', zooms.length > 0 && inView > 0 && inView + fullView === lefts.length,
  `${zooms.length} zoom (${zooms.filter((z) => z.origin === 'auto').length} otomatik); ${lefts.length} sol tıklamanın ${inView} tanesi zoom içinde, ${fullView} tanesi tam görünümde`);
result.zooms = zooms.map((z) => ({ startS: r3(z.start / TICKS), endS: r3(z.end / TICKS), center: z.center, scale: z.scale, origin: z.origin, mode: z.mode }));

// ─── Microphone ─────────────────────────────────────────────────────────────
if (screenProbe?.rises?.length && micProbe?.toneOnsets?.length) {
  // Against the picture: each tone the mic heard vs the flash shown with it.
  const shown = screenProbe.rises.map((v) => v + startOffset('screen'));
  const tones = micProbe.toneOnsets.map((a) => a + startOffset('mic'));
  const pairs = tones.map((a) => { const f = near(a, shown); return { at: f, ms: (a - f) * 1000 }; }).filter((p) => Math.abs(p.ms) < 500);
  if (pairs.length >= 2) {
    const drift = pairs[pairs.length - 1].ms - pairs[0].ms;
    check('Mikrofon görüntüyle eşzamanlı (±45 ms, kayma < 20 ms)', pairs.every((p) => Math.abs(p.ms) <= 45) && Math.abs(drift) < 20,
      `${pairs.length} ton; ortanca ${median(pairs.map((p) => p.ms)).toFixed(1)} ms, aralık ${Math.min(...pairs.map((p) => p.ms)).toFixed(1)}…${Math.max(...pairs.map((p) => p.ms)).toFixed(1)} ms, baştan sona kayma ${drift.toFixed(1)} ms (artı: ses geç)`);
    result.micSync = pairs.map((p) => ({ atS: r3(p.at), ms: r1(p.ms) }));
  } else check('Mikrofon görüntüyle eşzamanlı', false, `mikrofonda yalnızca ${micProbe.toneOnsets.length} ton bulundu (hoparlör sesi kapalı olabilir)`);
  // Against the app's clock: each tone vs when the pattern's beep left the speaker.
  const beeps = flashes.map((f) => f.beep).filter((b) => b !== null);
  if (beeps.length) {
    const errs = tones.map((a) => (a - near(a, beeps)) * 1000).filter((e) => Math.abs(e) < 500);
    if (errs.length) {
      check('Mikrofon kayıt saatiyle eşzamanlı (±45 ms; bip hoparlörden çıktığı an)', errs.every((e) => Math.abs(e) <= 45), `${errs.length} ton; ortanca ${median(errs).toFixed(1)} ms, aralık ${Math.min(...errs).toFixed(1)}…${Math.max(...errs).toFixed(1)} ms (artı: ses geç)`);
      result.micVsClockMs = errs.map(r1);
    }
  }
}

// ─── Sources cover the recording ────────────────────────────────────────────
for (const [k, s] of Object.entries(rec.sources)) {
  const end = (s.startOffset + s.duration) / TICKS;
  check(`Kaynak "${k}" kaydın sonuna kadar sürüyor`, Math.abs(end - rec.duration / TICKS) < 0.3, `başlangıç ${(s.startOffset / TICKS).toFixed(3)} sn, bitiş ${end.toFixed(3)} sn, kayıt ${(rec.duration / TICKS).toFixed(3)} sn`);
}

result.ok = result.checks.every((c) => c.ok);
for (const c of result.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
if (opt('--out')) writeFileSync(opt('--out'), `${JSON.stringify(result, null, 1)}\n`);
process.exit(result.ok ? 0 : 1);
