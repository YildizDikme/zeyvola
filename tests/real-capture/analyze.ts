// Turns a harness run (report.json + recorded files) into measured results.
// Bundled and run by run-real-capture.mjs:  node analyze.js <work dir> <media-probe> <results.json>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCursorLog, presetTransition } from '@zeyvola/project-model';
import { TICKS_PER_SECOND } from '@zeyvola/timing';
import { ENGINE_VERSION, suggestZooms } from '@zeyvola/zoom-engine';
import type { Recording } from '@zeyvola/project-model';
import type { HelperMessage, ProbedFile } from '../../apps/desktop/src/main/capture/helper-client';
import type { FolderResult, SessionLog } from '../../apps/desktop/src/main/capture/recovery';

// Shape of report.json as written by harness/main.cjs (only the fields read here).
type Stopped = Extract<HelperMessage, { type: 'stopped' }>;
/** A track from the helper's "stopped" report or, after a kill, from its session log. */
interface TrackFile { kind: string; startOffsetMs: number; durationMs?: number; samples?: number; dropped?: number }
interface ClickEvent { type: 'click'; epochMs: number; target: number; inOrder?: boolean; x: number; y: number }
interface FlashEvent { type: 'flash'; epochMs: number; audio: string }
type PatternEvent = ClickEvent | FlashEvent | { type: 'eventTiming' | 'loaded'; epochMs: number };
interface Pause { from: number; to?: number }
interface UsageSample { t: number; cpu: number; rssMB: number }
interface RecoveryReport {
  error?: string; ms?: number; results?: FolderResult[]; errors?: string[]; again?: string[];
  projectFile?: string; recordingsInProject?: number; segments?: { start: number; end: number }[];
  recording?: Recording | null; session?: SessionLog | null; probed?: ProbedFile[];
}
interface ScenarioReport {
  name: string; target: string; fps: number; quality: string; excludeOwnAudio?: boolean; mic?: boolean;
  error?: string; exitCode: number | null; out: string; windowBounds: { width: number; height: number };
  timings?: { prepareMs?: number; goMs?: number; stopMs?: number }; statuses: number; maxDropped: number; ready?: unknown;
  started?: Extract<HelperMessage, { type: 'started' }>; stopped?: Stopped; recovery?: RecoveryReport;
  usage?: UsageSample[]; pauses?: Pause[]; pattern?: PatternEvent[]; files?: { name: string; bytes: number }[];
  wallMs?: number; killedAtMs?: number; marksSent?: number;
}
interface RunReport {
  startedAt: string; finishedAt?: string; electron: string; arch: string; permissions?: unknown; errors: unknown[];
  scenarios: ScenarioReport[];
}

const [work, probe, resultsPath] = process.argv.slice(2) as [string, string, string];
const report = JSON.parse(readFileSync(join(work, 'kayitlar', 'report.json'), 'utf8')) as RunReport;

// Layout of the test pattern (fractions of the window), see pattern/index.html.
const SYNC = [0.89, 0.05, 0.08, 0.12];
const TARGETS = [[0.2, 0.42], [0.5, 0.42], [0.8, 0.42], [0.2, 0.72], [0.5, 0.72], [0.8, 0.72]] as const;
const targetBox = ([x, y]: readonly [number, number]) => [x - 0.025, y - 0.04, 0.05, 0.08];

// Output of media-probe.swift (only the fields read here).
interface VideoProbe {
  kind: 'video'; frames: number; span: number; medianInterval: number; p99Interval: number; maxInterval: number;
  gaps: number; width: number; height: number; regions: { rect: number[]; rises: number[] }[];
}
interface AudioProbe { kind: 'audio'; span: number; sampleRate: number; channels: number; peak: number; toneOnsets: number[] }
interface ProbeError { error: string; frames?: undefined }
/** What execFileSync throws (stdout is set when the probe ran and failed). */
type ExecError = { stdout?: string; message?: string };
function probeFile<P extends VideoProbe | AudioProbe = VideoProbe | AudioProbe>(file: string, regions?: number[][]): P | ProbeError {
  if (!existsSync(file)) return { error: 'missing' };
  try {
    const extra = regions ? ['--regions', regions.map((r) => r.join(',')).join(';')] : [];
    return JSON.parse(execFileSync(probe, [file, ...extra], { encoding: 'utf8', maxBuffer: 64 << 20 })) as P | ProbeError;
  } catch (e) {
    return { error: String((e as ExecError).stdout || (e as ExecError).message).trim().slice(0, 300) };
  }
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const stats = (xs: number[]) => xs.length
  ? { n: xs.length, mean: round(xs.reduce((a, b) => a + b, 0) / xs.length), min: round(Math.min(...xs)), max: round(Math.max(...xs)) }
  : { n: 0 };

/** Least-squares slope of y over x (ms per minute if x is minutes). */
function slope(points: [number, number][]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p[0], 0) / n;
  const my = points.reduce((a, p) => a + p[1], 0) / n;
  const num = points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const den = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return den ? num / den : null;
}

/** Pairs each flash with the nearest tone onset (within 300 ms); returns offsets in ms. */
function pair(flashes: number[], onsets: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const f of flashes) {
    let best: number | null = null;
    for (const o of onsets) if (Math.abs(o - f) < 0.3 && (best === null || Math.abs(o - f) < Math.abs(best - f))) best = o;
    if (best !== null) out.push([f, (best - f) * 1000]);
  }
  return out;
}

/** What this script reports for one scenario; `screen` is read again by recoveryResult(). */
interface ScenarioResult {
  [key: string]: unknown;
  screen?: ProbeError | { frames: number; [key: string]: unknown };
}

const results: Record<string, unknown>[] = [];
for (const sc of report.scenarios) {
  const r: ScenarioResult = { name: sc.name, target: sc.target, fps: sc.fps, quality: sc.quality, excludeOwnAudio: sc.excludeOwnAudio !== false, error: sc.error ?? null, exitCode: sc.exitCode };
  const files: Record<string, TrackFile> = {};
  // Offsets from the helper's report, or (killed helper) from its session log.
  for (const f of sc.stopped?.files ?? sc.recovery?.session?.tracks ?? []) files[f.kind] = f;
  r.helper = { prepareMs: sc.timings?.prepareMs, goMs: sc.timings?.goMs, stopMs: sc.timings?.stopMs, statuses: sc.statuses, maxDroppedReported: sc.maxDropped, ready: sc.ready };
  r.files = sc.files;
  const cpu = (sc.usage ?? []).slice(2).map((u) => u.cpu); // skip warm-up samples
  r.usage = { helperCpuPercent: stats(cpu), helperRssMBMax: Math.max(0, ...(sc.usage ?? []).map((u) => u.rssMB)) };

  const off = (kind: string) => (files[kind]?.startOffsetMs ?? 0) / 1000;
  const screen = probeFile<VideoProbe>(join(sc.out, 'screen.mp4'), [SYNC, ...TARGETS.map(targetBox)]);
  r.screen = 'error' in screen ? screen : {
    frames: screen.frames, span: round(screen.span, 3), effectiveFps: round((screen.frames - 1) / Math.max(1e-6, screen.span), 2),
    medianIntervalMs: round(screen.medianInterval * 1000, 2), p99IntervalMs: round(screen.p99Interval * 1000, 2), maxIntervalMs: round(screen.maxInterval * 1000, 1),
    gaps: screen.gaps, size: `${screen.width}x${screen.height}`, startOffsetMs: files.screen?.startOffsetMs, reportedDurationMs: files.screen?.durationMs,
    appended: files.screen?.samples, droppedByWriter: files.screen?.dropped,
  };
  const flashes: number[] = 'error' in screen ? [] : screen.regions[0]!.rises.map((t) => t + off('screen'));
  r.flashesInVideo = flashes.length;
  // Flashes the pattern showed while the recording ran (not paused, before stop).
  const t0 = sc.started?.startedAtMs ?? 0;
  const inPause = (ms: number) => (sc.pauses ?? []).some((p) => ms >= p.from && ms < (p.to ?? Infinity));
  const end = t0 + (sc.stopped?.durationMs ?? 0) + (sc.pauses ?? []).reduce((a: number, p) => a + ((p.to ?? p.from) - p.from), 0);
  r.flashesShownWhileRecording = (sc.pattern ?? []).filter((e) => e.type === 'flash' && e.epochMs >= t0 + 50 && e.epochMs <= end - 150 && !inPause(e.epochMs - t0)).length;
  r.patternAudio = [...new Set((sc.pattern ?? []).filter((e): e is FlashEvent => e.type === 'flash').map((e) => e.audio))];

  for (const kind of ['camera', 'mic', 'system'] as const) {
    const name = kind === 'camera' ? 'camera.mp4' : `${kind}.m4a`;
    if (!existsSync(join(sc.out, name))) continue;
    const p = probeFile<VideoProbe | AudioProbe>(join(sc.out, name));
    if ('error' in p) { r[kind] = p; continue; }
    if (p.kind === 'video') {
      r[kind] = { frames: p.frames, span: round(p.span, 3), effectiveFps: round((p.frames - 1) / Math.max(1e-6, p.span), 2), maxIntervalMs: round(p.maxInterval * 1000, 1), gaps: p.gaps, size: `${p.width}x${p.height}`, startOffsetMs: files[kind]?.startOffsetMs };
    } else {
      const onsets = p.toneOnsets.map((t) => t + off(kind));
      const pairs = pair(flashes, onsets);
      r[kind] = {
        span: round(p.span, 3), sampleRate: p.sampleRate, channels: p.channels, peak: round(p.peak, 3), startOffsetMs: files[kind]?.startOffsetMs,
        toneOnsets: onsets.length, pairedWithFlash: pairs.length,
        avOffsetMs: stats(pairs.map((x) => x[1])),
        driftMsPerMinute: pairs.length >= 3 ? round(slope(pairs.map(([t, o]) => [t / 60, o]))!, 2) : null,
      };
    }
  }

  // Pointer, clicks and the automatic zoom built from them.
  const cursorPath = join(sc.out, 'cursor.jsonl');
  if (existsSync(cursorPath)) {
    const track = parseCursorLog(readFileSync(cursorPath, 'utf8'));
    const downs = track.clicks.filter((c) => c.kind === 'down');
    const pageClicks = (sc.pattern ?? []).filter((e): e is ClickEvent => e.type === 'click');
    const w = sc.windowBounds.width, h = sc.windowBounds.height;
    const posErr = downs.map((d, i) => {
      const p = pageClicks[i];
      return p ? Math.hypot((d.x - p.x) * w, (d.y - p.y) * h) : NaN;
    }).filter(Number.isFinite);
    // Click time in the log vs the target turning white in the screen video.
    const lags: number[] = [];
    if (!('error' in screen)) {
      downs.forEach((d, i) => {
        const target = pageClicks[i]?.target;
        if (!target) return;
        const rises: number[] = screen.regions[target]!.rises.map((t) => t + off('screen'));
        const ts = d.t / TICKS_PER_SECOND;
        const next = rises.find((x) => x >= ts - 0.2);
        if (next !== undefined) lags.push((next - ts) * 1000);
      });
    }
    const duration = sc.stopped ? Math.round((sc.stopped.durationMs / 1000) * TICKS_PER_SECOND) : 0;
    const zooms = duration ? suggestZooms({
      recordingId: sc.name, duration, track, hasClicks: true, sensitivity: 'medium',
      markers: sc.stopped?.markers ?? [], defaults: { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') },
    }) : [];
    // A click counts as covered when it falls inside the inner 80 % of a zoom's view.
    const covered = downs.filter((d) => zooms.some((z) => z.start <= d.t && d.t < z.end
      && Math.abs(z.center.x - d.x) < 0.4 / z.scale && Math.abs(z.center.y - d.y) < 0.4 / z.scale)).length;
    const fullView = downs.filter((d) => !zooms.some((z) => z.start <= d.t && d.t < z.end)).length;
    r.cursor = {
      samples: track.samples.length, clicksDown: downs.length, clicksUp: track.clicks.length - downs.length, scrolls: track.scrolls.length,
      pageClicks: pageClicks.length, positionErrorPt: stats(posErr), clickToVideoFlashMs: stats(lags),
      // Unchanged positions are not repeated (2 Hz heartbeat), so this is lines per second, not the poll rate.
      loggedMovesPerSecond: track.samples.length > 1 ? round(track.samples.length / ((track.samples.at(-1)!.t - track.samples[0]!.t) / TICKS_PER_SECOND), 1) : 0,
      clickTimesS: downs.map((d) => round(d.t / TICKS_PER_SECOND, 3)),
    };
    r.autoZoom = {
      suggestions: zooms.length, clicksInsideAZoom: covered, clicksInFullView: fullView, engine: ENGINE_VERSION,
      items: zooms.map((z) => ({ start: round(z.start / TICKS_PER_SECOND, 2), end: round(z.end / TICKS_PER_SECOND, 2), center: [round(z.center.x, 3), round(z.center.y, 3)], scale: round(z.scale, 2), confidence: z.confidence !== undefined ? round(z.confidence, 2) : null })),
    };
  }

  if (sc.stopped) {
    const paused = (sc.pauses ?? []).reduce((a: number, p) => a + ((p.to ?? p.from) - p.from), 0);
    r.timing = {
      durationMs: round(sc.stopped.durationMs), wallMs: sc.wallMs, pausedMs: paused,
      // Recording length vs wall clock minus pauses; small differences come from command latency.
      durationMinusExpectedMs: round(sc.stopped.durationMs - ((sc.wallMs ?? 0) - paused - (sc.timings?.stopMs ?? 0))),
      markers: sc.stopped.markers.length,
    };
  }
  if (sc.recovery) r.recovery = recoveryResult(sc, r);
  results.push(r);
}

/** The recording the app rebuilt into its project after the helper died (or the app quit). */
function recoveryResult(sc: ScenarioReport, r: ScenarioResult): Record<string, unknown> {
  const rv = sc.recovery!; // only called when the scenario has a recovery report
  if (rv.error) return { error: rv.error, checks: [{ name: 'kurtarma çalıştı', ok: false }] };
  const rec = rv.recording;
  const ms = (t: number) => round((t / TICKS_PER_SECOND) * 1000, 1);
  const recoveredMs = rec ? ms(rec.duration) : 0;
  const paused = (sc.pauses ?? []).reduce((a: number, p) => a + ((p.to ?? p.from) - p.from), 0);
  const marks = sc.marksSent ?? 0;
  const probedScreen = rv.probed?.find((p) => p.name === 'screen.mp4');
  // `ok` stays undefined when the report lacks the field (left out of results.json, counts as failed).
  const checks: { name: string; ok: boolean | undefined; detail?: unknown }[] = [
    { name: 'kayıt projeye eklendi', ok: !!rec, detail: rv.results?.map((x) => x.status) },
    { name: 'zaman çizelgesinde tek parça, kayıt boyunca', ok: rv.segments?.length === 1 && rv.segments[0]!.end === rec?.duration },
    { name: 'ekran kaynağı', ok: !!rec?.sources?.screen },
    ...(sc.mic ? [{ name: 'mikrofon kaynağı, günlükteki başlangıçla', ok: !!rec?.sources?.mic && Math.abs(ms(rec.sources.mic.startOffset) - (files(sc).mic?.startOffsetMs ?? -1)) < 0.1 }] : []),
    { name: 'ekran süresi okunabilen karelere eşit', ok: typeof r.screen?.frames === 'number' && probedScreen?.samples === r.screen.frames, detail: { probe: probedScreen?.samples, decoded: r.screen?.frames } },
    { name: 'imleç günlüğü bağlı', ok: rec?.cursorFile?.endsWith('/cursor.jsonl') === true && rec?.capture?.hasClicks === true },
    { name: 'işaretler korundu', ok: (rec?.markers?.length ?? -1) === marks, detail: rec?.markers?.map((m) => round(m / TICKS_PER_SECOND, 3)) },
    { name: 'hedef bilgisi uygulamadan (pencere)', ok: rec?.capture?.target?.kind === sc.target && rec?.capture?.target?.label === 'Zeyvola Test Deseni' },
    { name: 'ikinci açılışta yeniden eklenmez', ok: rv.recordingsInProject === 1 && rv.again?.includes('in-project') },
  ];
  let lossMs: number | null = null;
  if (sc.killedAtMs !== undefined) {
    // Recording time when the helper was killed (pauses removed) minus what was recovered.
    lossMs = round(sc.killedAtMs - paused - recoveredMs);
    checks.push({ name: 'kayıp en çok bir parça (2 sn)', ok: lossMs >= -150 && lossMs <= 2150, detail: lossMs });
  } else if (sc.stopped) {
    checks.push({ name: 'süre yardımcının kendi bitişiyle aynı', ok: Math.abs(recoveredMs - sc.stopped.durationMs) < 1, detail: { recoveredMs, stoppedMs: round(sc.stopped.durationMs) } });
  }
  return {
    ok: checks.every((c) => c.ok), checks, recoveredMs, lossMs, recoveryMs: rv.ms, projectFile: rv.projectFile,
    cleanEnd: rv.session?.endDurationMs !== null, sessionLines: { tracks: rv.session?.tracks?.length, markers: rv.session?.markers?.length },
    sources: Object.fromEntries(Object.entries(rec?.sources ?? {}).map(([k, s]) => [k, { startOffsetMs: ms(s.startOffset), durationMs: ms(s.duration), file: s.file.split('/').pop() }])),
    probed: rv.probed, errors: rv.errors,
  };
}

function files(sc: ScenarioReport): Record<string, TrackFile> {
  const out: Record<string, TrackFile> = {};
  for (const f of sc.stopped?.files ?? sc.recovery?.session?.tracks ?? []) out[f.kind] = f;
  return out;
}

const summary = {
  run: { startedAt: report.startedAt, finishedAt: report.finishedAt, electron: report.electron, arch: report.arch, permissions: report.permissions, errors: report.errors },
  scenarios: results,
};
writeFileSync(resultsPath, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
