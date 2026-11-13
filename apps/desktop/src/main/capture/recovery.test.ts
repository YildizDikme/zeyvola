import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Recording } from '@zeyvola/project-model';
import { msToTicks, secondsToTicks } from '@zeyvola/timing';
import type { ProbedFile } from './helper-client';
import { parseSessionLog, rebuildRecording, recoverAbandoned, recoverFolder, RECOVERY_FILE, SESSION_FILE, type RecoveryDeps, type SessionLog } from './recovery';

const META = { recordingId: 'rec_abcdef12', backend: 'native-macos', target: { kind: 'window', label: 'Test Deseni', bounds: { x: 40, y: 300, w: 960, h: 600 }, scaleFactor: 2 } };
const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const HEADER = { e: 'session', v: 1, startedAtMs: Date.UTC(2026, 9, 17, 10, 0, 0), pid: 4242, cursor: 'cursor.jsonl', meta: META };
const SCREEN = { e: 'track', kind: 'screen', name: 'screen.mp4', mime: 'video/mp4', startOffsetMs: 0, width: 1920, height: 1200, fps: 30 };
const MIC = { e: 'track', kind: 'mic', name: 'mic.m4a', mime: 'audio/mp4', startOffsetMs: 7.19, sampleRate: 48000, channels: 1 };
const CAMERA = { e: 'track', kind: 'camera', name: 'camera.mp4', mime: 'video/mp4', startOffsetMs: 6500, width: 1280, height: 720, fps: 30 };
/** What a crash at ~7 s leaves: everything up to the last complete 2 s fragment. */
const PROBED: ProbedFile[] = [
  { name: 'screen.mp4', kind: 'video', durationMs: 5985, samples: 177, firstMs: 0 },
  { name: 'mic.m4a', kind: 'audio', durationMs: 5990, samples: 281, firstMs: 7.19 }, // its fragments end a little later
  { name: 'camera.mp4', kind: 'video', durationMs: 400, samples: 12, firstMs: 6500 },
];
const FILES = ['session.jsonl', 'screen.mp4', 'mic.m4a', 'camera.mp4', 'cursor.jsonl'];

function crashLog(): SessionLog {
  return parseSessionLog(lines(HEADER, SCREEN, MIC, { e: 'pause', t: 100 }, { e: 'resume', t: 100 }, { e: 'mark', t: secondsToTicks(2) }, CAMERA, { e: 'mark', t: secondsToTicks(6.5) }))!;
}

describe('session log', () => {
  it('reads every kind of line and skips one cut off by a crash', () => {
    const log = parseSessionLog(lines(HEADER, SCREEN, MIC, { e: 'mark', t: 705_600_000 }) + '{"e":"track","kind":"cam');
    expect(log).toMatchObject({ startedAtMs: HEADER.startedAtMs, pid: 4242, cursor: 'cursor.jsonl', meta: META, endDurationMs: null, cancelled: false, markers: [705_600_000] });
    expect(log!.tracks.map((t) => t.kind)).toEqual(['screen', 'mic']);
    expect(log!.tracks[1]).toEqual({ kind: 'mic', name: 'mic.m4a', mime: 'audio/mp4', startOffsetMs: 7.19, sampleRate: 48000, channels: 1, width: undefined, height: undefined, fps: undefined });
  });

  it('needs the session line first and keeps the first track of each kind', () => {
    expect(parseSessionLog(lines(SCREEN, MIC))).toBeNull();
    expect(parseSessionLog('')).toBeNull();
    const log = parseSessionLog(lines(SCREEN, HEADER, { ...SCREEN, name: 'screen2.mp4' }, SCREEN, { e: 'end', durationMs: 5003.2 }))!;
    expect(log.tracks).toEqual([expect.objectContaining({ name: 'screen2.mp4' })]);
    expect(log.endDurationMs).toBe(5003.2);
  });

  it('refuses file names that leave the recording folder and malformed values', () => {
    const log = parseSessionLog(lines(
      { ...HEADER, cursor: '../cursor.jsonl', meta: { ...META, target: { ...META.target, kind: 'tv' } } },
      { ...SCREEN, name: '../../project.json' }, { ...SCREEN, name: '/etc/hosts' }, { ...MIC, kind: 'keyboard' }, { ...MIC, startOffsetMs: 'soon' },
      { e: 'mark', t: -5 },
    ))!;
    expect(log).toMatchObject({ cursor: null, meta: null, tracks: [], markers: [] });
  });

  it('marks a cancelled session', () => {
    expect(parseSessionLog(lines(HEADER, SCREEN, { e: 'cancelled' }))!.cancelled).toBe(true);
  });
});

describe('rebuilding a recording', () => {
  const input = (log: SessionLog, probed = PROBED, files = FILES) => ({ recordingId: 'rec_abcdef12', log, probed, files, platform: 'darwin-arm64', fallbackLabel: 'Kurtarılan kayıt' });

  it('puts each file on the recording clock with the length that can be played', () => {
    const r = rebuildRecording(input(crashLog()))!;
    expect(r.cleanEnd).toBe(false);
    expect(r.recoveredMs).toBeCloseTo(5985, 6);
    const rec = r.recording;
    expect(rec).toMatchObject({
      id: 'rec_abcdef12', createdAt: '2026-10-17T10:00:00.000Z', duration: msToTicks(5985), cursorFile: 'media/rec_abcdef12/cursor.jsonl', syncOffsets: {},
      capture: { backend: 'native-macos', platform: 'darwin-arm64', target: META.target, cursorInFrames: false, hasClicks: true },
    });
    expect(rec.sources.screen).toEqual({ kind: 'screen', file: 'media/rec_abcdef12/screen.mp4', mime: 'video/mp4', width: 1920, height: 1200, fps: 30, sampleRate: undefined, channels: undefined, startOffset: 0, duration: msToTicks(5985) });
    // The microphone may not run past the end of the screen video.
    expect(rec.sources.mic).toMatchObject({ startOffset: msToTicks(7.19), duration: msToTicks(5985) - msToTicks(7.19), sampleRate: 48000, channels: 1 });
    // The camera opened after the screen's last complete fragment: nothing of it is left to show.
    expect(rec.sources.camera).toBeUndefined();
    expect(rec.markers).toEqual([secondsToTicks(2)]);
  });

  it('uses the helper\'s own end time when it closed the files itself', () => {
    const log = parseSessionLog(lines(HEADER, SCREEN, MIC, { e: 'end', durationMs: 5003.2 }))!;
    const r = rebuildRecording(input(log, [{ name: 'screen.mp4', durationMs: 4995 }, { name: 'mic.m4a', durationMs: 4992 }]))!;
    expect(r.cleanEnd).toBe(true);
    expect(r.recording.duration).toBe(msToTicks(5003.2));
    expect(r.recording.sources.screen!.duration).toBe(msToTicks(4995));
  });

  it('skips files that cannot be played and needs the screen', () => {
    const noMic = rebuildRecording(input(crashLog(), [PROBED[0]!, { name: 'mic.m4a', error: 'no-samples' }]))!;
    expect(Object.keys(noMic.recording.sources)).toEqual(['screen']);
    expect(rebuildRecording(input(crashLog(), [{ name: 'screen.mp4', error: 'reader: failed' }, PROBED[1]!]))).toBeNull();
    expect(rebuildRecording(input(crashLog(), [{ name: 'screen.mp4', durationMs: 0, samples: 0 }]))).toBeNull();
    expect(rebuildRecording(input(crashLog(), PROBED, FILES.filter((f) => f !== 'screen.mp4')))).toBeNull();
    expect(rebuildRecording(input(parseSessionLog(lines(HEADER, MIC))!))).toBeNull();
  });

  it('keeps nothing of a cancelled session', () => {
    expect(rebuildRecording(input(parseSessionLog(lines(HEADER, SCREEN, { e: 'cancelled' }))!))).toBeNull();
  });

  it('falls back when the app left no description and the pointer log is gone', () => {
    const log = parseSessionLog(lines({ e: 'session', v: 1 }, { ...MIC, sampleRate: undefined, channels: undefined }, SCREEN))!;
    const r = rebuildRecording(input(log, PROBED.map((p) => (p.name === 'mic.m4a' ? { ...p, sampleRate: 44100, channels: 2 } : p)), ['screen.mp4', 'mic.m4a']))!;
    expect(r.recording.capture).toMatchObject({ backend: 'native-macos', target: { kind: 'display', label: 'Kurtarılan kayıt', scaleFactor: 1 }, hasClicks: false });
    expect(r.recording.cursorFile).toBeUndefined();
    expect(r.recording.sources.mic).toMatchObject({ sampleRate: 44100, channels: 2 });
  });
});

describe('recovery folders', () => {
  const temps: string[] = [];
  afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); }); // the test's own temp folders

  /** A project folder with one recording folder per entry: name → session log text. */
  function project(recs: Record<string, string | null>): string {
    const dir = mkdtempSync(join(tmpdir(), 'zeyvola-recovery-test-'));
    temps.push(dir);
    for (const [id, log] of Object.entries(recs)) {
      const rec = join(dir, 'media', id);
      mkdirSync(rec, { recursive: true });
      for (const f of FILES.slice(1)) writeFileSync(join(rec, f), 'x');
      if (log !== null) writeFileSync(join(rec, SESSION_FILE), log);
      const old = new Date(Date.now() - 60_000);
      for (const f of FILES) { try { utimesSync(join(rec, f), old, old); } catch { /* not written */ } }
    }
    return dir;
  }

  function deps(over: Partial<RecoveryDeps> = {}): RecoveryDeps & { added: Recording[]; probed: string[] } {
    const added: Recording[] = [];
    const probed: string[] = [];
    return {
      added, probed,
      probe: async (dir) => { probed.push(dir); return PROBED; },
      hasRecording: async (_p, id) => added.some((r) => r.id === id),
      appendRecording: async (_p, rec) => { added.push(rec); },
      platform: 'darwin-arm64',
      isAlive: () => false,
      ...over,
    };
  }

  const LOG = lines(HEADER, SCREEN, MIC, { e: 'mark', t: secondsToTicks(2) });

  it('adds a crashed recording to its project', async () => {
    const dir = project({ rec_abcdef12: LOG });
    const d = deps();
    const r = await recoverFolder('prj_aaaaaaaa', join(dir, 'media', 'rec_abcdef12'), 'rec_abcdef12', d);
    expect(r).toEqual({ status: 'recovered', projectId: 'prj_aaaaaaaa', recordingId: 'rec_abcdef12', recoveredMs: expect.closeTo(5985, 6), cleanEnd: false, sources: ['screen', 'mic'] });
    expect(d.added).toHaveLength(1);
    // A second look finds it in the project and leaves it alone.
    expect(await recoverFolder('prj_aaaaaaaa', join(dir, 'media', 'rec_abcdef12'), 'rec_abcdef12', d)).toMatchObject({ status: 'skipped', reason: 'in-project' });
  });

  it('marks a folder with nothing playable instead of trying it on every start', async () => {
    const dir = project({ rec_abcdef12: LOG });
    const rec = join(dir, 'media', 'rec_abcdef12');
    const d = deps({ probe: async () => [{ name: 'screen.mp4', error: 'no-samples' }] });
    expect(await recoverFolder('prj_aaaaaaaa', rec, 'rec_abcdef12', d)).toMatchObject({ status: 'empty' });
    expect(JSON.parse(readFileSync(join(rec, RECOVERY_FILE), 'utf8'))).toMatchObject({ status: 'empty' });
    expect(await recoverFolder('prj_aaaaaaaa', rec, 'rec_abcdef12', d)).toMatchObject({ status: 'skipped', reason: 'examined' });
    expect(d.added).toEqual([]);
    // The recorded files are left as they are.
    expect(readFileSync(join(rec, 'screen.mp4'), 'utf8')).toBe('x');
  });

  it('leaves alone cancelled sessions, folders without a log and a helper that is still writing', async () => {
    const dir = project({ rec_cancel01: lines(HEADER, SCREEN, { e: 'cancelled' }), rec_nolog001: null, rec_live0001: LOG });
    const d = deps({ isAlive: (pid) => pid === 4242 });
    const at = (id: string) => recoverFolder('prj_aaaaaaaa', join(dir, 'media', id), id, d);
    expect(await at('rec_cancel01')).toMatchObject({ status: 'skipped', reason: 'cancelled' });
    expect(await at('rec_nolog001')).toMatchObject({ status: 'skipped', reason: 'no-log' });
    // Helper alive but nothing written for a minute: it is not recording into this folder.
    expect(await at('rec_live0001')).toMatchObject({ status: 'recovered' });
    const fresh = project({ rec_live0002: LOG });
    writeFileSync(join(fresh, 'media', 'rec_live0002', 'screen.mp4'), 'xx'); // just written
    expect(await recoverFolder('prj_aaaaaaaa', join(fresh, 'media', 'rec_live0002'), 'rec_live0002', d)).toMatchObject({ status: 'skipped', reason: 'active' });
    expect(await recoverFolder('prj_aaaaaaaa', join(fresh, 'media', 'rec_live0002'), 'rec_live0002', deps({ isBusy: () => true }))).toMatchObject({ status: 'skipped', reason: 'active' });
    expect(d.probed).toHaveLength(1);
  });

  it('scans every project, skips known recordings and goes on after a failure', async () => {
    const a = project({ rec_known001: LOG, rec_lost0001: LOG, imp_0123456789ab: LOG });
    const b = project({ rec_lost0002: LOG, rec_broken01: LOG });
    const errors: string[] = [];
    const d = deps({ probe: async (dir) => { if (dir.endsWith('rec_broken01')) throw new Error('probe failed'); return PROBED; } });
    const results = await recoverAbandoned([
      { id: 'prj_aaaaaaaa', dir: a, recordingIds: new Set(['rec_known001']) },
      { id: 'prj_bbbbbbbb', dir: b, recordingIds: new Set() },
      { id: 'prj_cccccccc', dir: join(a, 'missing'), recordingIds: new Set() },
    ], d, (dir) => errors.push(dir));
    expect(results.filter((r) => r.status === 'recovered').map((r) => `${r.projectId}/${r.recordingId}`).sort()).toEqual(['prj_aaaaaaaa/rec_lost0001', 'prj_bbbbbbbb/rec_lost0002']);
    expect(errors).toEqual([join(b, 'media', 'rec_broken01')]);
    expect(d.added.map((r) => r.id).sort()).toEqual(['rec_lost0001', 'rec_lost0002']);
  });
});

describe('browser recording path (distribution B)', () => {
  const WEB_META = { recordingId: 'rec_web12345', backend: 'web', target: { kind: 'region', label: 'Bölge', bounds: { x: 40, y: 97, w: 1280, h: 800 }, scaleFactor: 2 }, crop: { x: 0.0265, y: 0.0988, w: 0.8466, h: 0.8147 } };
  const head = { e: 'session', startedAtMs: Date.UTC(2026, 9, 17, 11, 0, 0), pid: 999_999, cursor: 'cursor.jsonl', clicks: true, meta: WEB_META };
  const screen = { e: 'track', kind: 'screen', name: 'screen.webm', mime: 'video/webm', startOffsetMs: 3, width: 3024, height: 1964, fps: 60 };
  const mic = { e: 'track', kind: 'mic', name: 'mic.weba', mime: 'audio/webm', startOffsetMs: 12, sampleRate: 48000, channels: 1 };
  const probed: ProbedFile[] = [{ name: 'screen.webm', kind: 'video', durationMs: 41_016 }, { name: 'mic.weba', kind: 'audio', durationMs: 41_000 }];
  const files = ['session.jsonl', 'screen.webm', 'mic.weba', 'cursor.jsonl'];

  it('rebuilds with the cursor in the frames, the region crop and the clicks', () => {
    const log = parseSessionLog(lines(head, screen, mic, { e: 'mark', t: secondsToTicks(10) }))!;
    expect(log.meta).toEqual(WEB_META);
    const r = rebuildRecording({ recordingId: 'rec_web12345', log, probed, files, platform: 'darwin-arm64' })!;
    expect(r.recording.capture).toMatchObject({ backend: 'web', cursorInFrames: true, hasClicks: true, crop: WEB_META.crop });
    expect(r.recording.sources.screen).toMatchObject({ file: 'media/rec_web12345/screen.webm', startOffset: msToTicks(3), duration: msToTicks(41_016) });
    expect(r.recording.sources.mic?.startOffset).toBe(msToTicks(12));
    expect(r.recording.markers).toEqual([secondsToTicks(10)]);
    expect(r.cleanEnd).toBe(false);
  });

  it('keeps a microphone that starts just before the recording clock (captured before start)', () => {
    const early = { ...mic, startOffsetMs: -32.5 };
    const log = parseSessionLog(lines(head, screen, early, { e: 'pause', t: secondsToTicks(5), atMs: head.startedAtMs + 5000 }, { e: 'resume', t: secondsToTicks(5), atMs: head.startedAtMs + 8000 }, { e: 'end', durationMs: 41_003 }))!;
    const r = rebuildRecording({ recordingId: 'rec_web12345', log, probed, files, platform: 'darwin-arm64' })!;
    expect(r.recording.sources.mic?.startOffset).toBe(msToTicks(-32.5));
    expect(r.recording.sources.mic?.duration).toBe(msToTicks(41_000));
    // A broken log cannot push a file far before the recording.
    const wild = parseSessionLog(lines(head, screen, { ...mic, startOffsetMs: -90_000 }))!;
    expect(rebuildRecording({ recordingId: 'rec_web12345', log: wild, probed, files, platform: 'darwin-arm64' })!.recording.sources.mic?.startOffset).toBe(msToTicks(-1000));
  });

  it('keeps "no clicks" when the pointer helper did not run, and refuses a broken crop', () => {
    const log = parseSessionLog(lines({ ...head, clicks: false, meta: { ...WEB_META, crop: { x: 0, y: 0, w: 2, h: 1 } } }, screen))!;
    expect(log.meta?.crop).toBeUndefined();
    const r = rebuildRecording({ recordingId: 'rec_web12345', log, probed, files, platform: 'win32-x64' })!;
    expect(r.recording.capture.hasClicks).toBe(false);
    expect(r.recording.capture.crop).toBeUndefined();
  });
});
