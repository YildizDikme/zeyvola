import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureConfig } from '@zeyvola/protocol';
import { msToTicks } from '@zeyvola/timing';
import type { Recording } from '@zeyvola/project-model';
import { HelperClient, HelperError, parseHelperLine, parseProbeOutput, prepareCommand, probeFiles, recordingResult, type HelperMessage } from './helper-client';
import { parseSessionLog, recoverFolder, SESSION_FILE } from './recovery';
import type { BackendStartArgs } from './types';

const FAKE = join(import.meta.dirname, '__fixtures__', 'fake-helper.mjs');
const REAL = resolve(import.meta.dirname, '../../../../../native/recorder-macos/bin/zeyvola-recorder');

function args(target: Partial<CaptureConfig['target']> = {}, extra: Partial<CaptureConfig> = {}): BackendStartArgs {
  const config: CaptureConfig = {
    target: { kind: 'display', sourceId: 'screen:69733632:0', displayId: '69733632', label: 'Ekran 1', ...target },
    cameraDeviceId: 'cam-1', cameraLabel: 'Test Kamerası', micDeviceId: 'mic-1', micLabel: 'Test Mikrofonu',
    systemAudio: true, fps: 60, quality: 'high', countdown: 3, backend: 'native', ...extra,
  };
  const displayBounds = { x: 0, y: 0, w: 1512, h: 982 };
  return { config, outDir: '/tmp/zeyvola-test/rec_1', recordingId: 'rec_1', targetBounds: displayBounds, displayBounds, scaleFactor: 2 };
}

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zeyvola-helper-test-'));
  temps.push(d);
  return d;
}

const clients: HelperClient[] = [];
function fake(mode: string): HelperClient {
  const c = new HelperClient(process.execPath, [FAKE, mode]);
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close(100);
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); // the test's own temp folders
});

describe('helper protocol', () => {
  it('accepts known messages only', () => {
    expect(parseHelperLine('{"type":"hello","version":"1"}')).toEqual({ type: 'hello', version: '1' });
    expect(parseHelperLine('not json')).toBeNull();
    expect(parseHelperLine('{"type":"other"}')).toBeNull();
    expect(parseHelperLine('{"type":"stopped","files":"x","durationMs":1}')).toBeNull();
    expect(parseHelperLine('{"type":"error","fatal":true}')).toBeNull();
  });

  it('builds the prepare command for display, region and window targets', () => {
    const d = prepareCommand(args(), 4242);
    expect(d).toMatchObject({ cmd: 'prepare', display: 69733632, window: null, region: null, fps: 60, quality: 'high', systemAudio: true, excludePid: 4242 });
    expect(d.bounds).toEqual({ x: 0, y: 0, w: 1512, h: 982 });
    expect(d.camera).toEqual({ label: 'Test Kamerası' });
    expect(d.mic).toEqual({ label: 'Test Mikrofonu' });

    const r = prepareCommand(args({ kind: 'region', region: { x: 100, y: 50, w: 800, h: 600 } }), 1);
    expect(r.region).toEqual({ x: 100, y: 50, w: 800, h: 600 });
    expect(r.display).toBe(69733632);

    const w = prepareCommand(args({ kind: 'window', sourceId: 'window:5123:0', displayId: undefined }, { cameraDeviceId: null, micDeviceId: null }), 1);
    expect(w).toMatchObject({ display: null, window: 5123, bounds: null, camera: null, mic: null });
  });

  it('describes the recording for the session log, so it can be rebuilt after a crash', () => {
    expect(prepareCommand(args({ kind: 'region', region: { x: 100, y: 50, w: 800, h: 600 } }), 1).meta).toEqual({
      recordingId: 'rec_1', backend: 'native-macos',
      target: { kind: 'region', label: 'Ekran 1', bounds: { x: 0, y: 0, w: 1512, h: 982 }, scaleFactor: 2 },
    });
    expect((prepareCommand(args(), 1, 'native-windows').meta as { backend: string }).backend).toBe('native-windows');
  });

  it('reads the probe report and keeps per-file errors', () => {
    const files = parseProbeOutput([
      'log line',
      JSON.stringify({ type: 'probe', dir: '/x', files: [
        { name: 'screen.mp4', kind: 'video', durationMs: 5985, firstMs: 0, samples: 177, width: 1920, height: 1200, assetDurationMs: 6000 },
        { name: 'mic.m4a', error: 'no-samples' },
        { kind: 'video' }, // no name: dropped
        { name: 'odd.mp4', kind: 'subtitle', durationMs: 'long' },
      ] }),
    ].join('\n'));
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ name: 'screen.mp4', kind: 'video', durationMs: 5985, samples: 177, width: 1920 });
    expect(files[1]).toMatchObject({ name: 'mic.m4a', error: 'no-samples' });
    expect(files[2]).toEqual(expect.objectContaining({ name: 'odd.mp4', kind: undefined, durationMs: undefined }));
    expect(() => parseProbeOutput('{"type":"probe","error":"klasör yok"}')).toThrow(expect.objectContaining({ code: 'probe', message: 'klasör yok' }));
    expect(() => parseProbeOutput('')).toThrow(expect.objectContaining({ code: 'probe-output' }));
  });

  it('puts every file on the shared clock with its own offset and length', () => {
    const r = recordingResult({
      type: 'stopped', durationMs: 2000, cursor: 'cursor.jsonl', markers: [1], hasClicks: true,
      files: [
        { kind: 'screen', name: 'screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffsetMs: 0, durationMs: 2000 },
        { kind: 'camera', name: 'camera.mp4', mime: 'video/mp4', startOffsetMs: 40, durationMs: 1960 },
        { kind: 'mic', name: 'mic.m4a', mime: 'audio/mp4', startOffsetMs: 12.5 },
        { kind: 'system', name: 'system.m4a', mime: 'audio/mp4', startOffsetMs: 0, error: 'x' },
      ],
    }, args(), 'native-macos');
    expect(r.sources.screen).toMatchObject({ file: 'media/rec_1/screen.mp4', startOffset: 0, duration: msToTicks(2000), width: 1920 });
    expect(r.sources.camera).toMatchObject({ startOffset: msToTicks(40), duration: msToTicks(1960) });
    expect(r.sources.mic).toMatchObject({ startOffset: msToTicks(12.5), duration: msToTicks(1987.5) });
    expect(r.sources.system).toBeUndefined(); // a file that failed to close is not offered
    expect(r.cursorFile).toBe('media/rec_1/cursor.jsonl');
    expect(r.capture).toMatchObject({ backend: 'native-macos', cursorInFrames: false, hasClicks: true });
    expect(r.durationTicks).toBe(msToTicks(2000));
  });
});

describe('helper process (stand-in)', () => {
  it('prepares, records, marks and stops', async () => {
    const c = fake('normal');
    const events: HelperMessage[] = [];
    c.on('message', (m: HelperMessage) => events.push(m));
    expect((await c.open()).version).toBe('0.0.0-test');
    const ready = c.waitFor('ready', 2000);
    c.send(prepareCommand(args(), 1));
    expect(await ready).toMatchObject({ type: 'ready', screenWidth: 1920 });
    const started = c.waitFor('started', 2000);
    c.send({ cmd: 'go' });
    await started;
    c.send({ cmd: 'mark' });
    const stopped = c.waitFor('stopped', 2000);
    c.send({ cmd: 'stop' });
    const m = (await stopped) as Extract<HelperMessage, { type: 'stopped' }>;
    expect(m.markers).toHaveLength(1);
    expect(events.some((e) => e.type === 'status')).toBe(true);
    const r = recordingResult(m, args(), 'native-macos');
    expect(Object.keys(r.sources).sort()).toEqual(['camera', 'mic', 'screen']);
  });

  it('turns a fatal helper error into a coded error for the waiting call', async () => {
    const c = fake('deny-screen');
    await c.open();
    const ready = c.waitFor('ready', 2000);
    c.send(prepareCommand(args(), 1));
    await expect(ready).rejects.toMatchObject({ code: 'screen-permission' });
  });

  it('reports a crash during recording', async () => {
    const c = fake('crash-after-go');
    await c.open();
    const exited = new Promise<number | null>((r) => c.once('exit', (code: number | null) => r(code)));
    const started = c.waitFor('started', 2000);
    c.send({ cmd: 'go' });
    await started;
    const stopped = c.waitFor('stopped', 5000);
    expect(await exited).toBe(3);
    await expect(stopped).rejects.toBeInstanceOf(HelperError);
    expect(c.running).toBe(false);
  });

  it('times out when the helper never answers', async () => {
    const c = fake('silent');
    await expect(c.open(300)).rejects.toMatchObject({ code: 'timeout', message: 'hello' });
  });

  it('probes a folder through the helper and passes its error on', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake-probe.json'), JSON.stringify([{ name: 'screen.mp4', kind: 'video', durationMs: 4000 }]));
    expect(await probeFiles(process.execPath, dir, [FAKE])).toEqual([expect.objectContaining({ name: 'screen.mp4', durationMs: 4000 })]);
    await expect(probeFiles(process.execPath, join(dir, 'missing'), [FAKE])).rejects.toMatchObject({ code: 'probe' });
  });

  it('leaves a session log that rebuilds the recording after the helper is killed', async () => {
    const outDir = join(tempDir(), 'media', 'rec_crash0001');
    const a = { ...args(), outDir, recordingId: 'rec_crash0001' };
    const c = fake('crash-with-files');
    await c.open();
    const ready = c.waitFor('ready', 2000);
    c.send(prepareCommand(a, 1));
    await ready;
    const started = c.waitFor('started', 2000);
    c.send({ cmd: 'go' });
    await started;
    c.send({ cmd: 'mark' });
    await new Promise((r) => setTimeout(r, 100));
    const exited = new Promise<number | null>((r) => c.once('exit', (code: number | null) => r(code)));
    process.kill(c.pid!, 'SIGKILL');
    await exited;

    const log = parseSessionLog(readFileSync(join(outDir, SESSION_FILE), 'utf8'));
    expect(log?.meta).toEqual(prepareCommand(a, 1).meta);
    expect(log?.markers).toHaveLength(1);
    const added: Recording[] = [];
    const r = await recoverFolder('prj_test0001', outDir, 'rec_crash0001', {
      probe: (dir) => probeFiles(process.execPath, dir, [FAKE]),
      hasRecording: async () => false,
      appendRecording: async (_id, rec) => { added.push(rec); },
      platform: 'test-arm64',
      isAlive: () => false,
    });
    expect(r).toMatchObject({ status: 'recovered', recoveredMs: 6000, cleanEnd: false, sources: ['screen', 'mic'] });
    expect(added[0]).toMatchObject({
      id: 'rec_crash0001', duration: msToTicks(6000), cursorFile: 'media/rec_crash0001/cursor.jsonl',
      capture: { backend: 'native-macos', platform: 'test-arm64', target: { kind: 'display', label: 'Ekran 1', scaleFactor: 2 }, hasClicks: true },
    });
    expect(added[0]!.sources.mic).toMatchObject({ startOffset: msToTicks(12.5), duration: msToTicks(5980) });
    expect(added[0]!.markers).toEqual(log?.markers);
  });

  it('reports a helper that dies while closing the files as a crash, not a result', async () => {
    const c = fake('crash-with-files');
    await c.open();
    const ready = c.waitFor('ready', 2000);
    c.send(prepareCommand({ ...args(), outDir: join(tempDir(), 'rec_x') }, 1));
    await ready;
    const started = c.waitFor('started', 2000);
    c.send({ cmd: 'go' });
    await started;
    const stopped = c.waitFor('stopped', 2000);
    c.send({ cmd: 'stop' });
    await expect(stopped).rejects.toMatchObject({ code: 'exited' });
  });

  it('passes a system interruption on as a message', async () => {
    const c = fake('interrupt');
    await c.open();
    const got = new Promise<HelperMessage>((r) => c.on('message', (m: HelperMessage) => { if (m.type === 'interrupted') r(m); }));
    c.send({ cmd: 'go' });
    expect(await got).toMatchObject({ code: 'screen-stopped' });
  });
});

// The real Swift helper, on paths that capture nothing and need no permission.
describe.skipIf(process.platform !== 'darwin' || !existsSync(REAL))('macOS helper binary', () => {
  it('greets, rejects bad commands with codes and exits on cancel', async () => {
    const c = new HelperClient(REAL);
    clients.push(c);
    const hello = await c.open();
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(['arm64', 'x86_64']).toContain(hello.arch);
    const errors: HelperMessage[] = [];
    c.on('message', (m: HelperMessage) => errors.push(m));
    c.send({ cmd: 'nonsense' });
    const ready = c.waitFor('ready', 3000);
    c.send({ cmd: 'prepare' }); // no outDir
    await expect(ready).rejects.toMatchObject({ code: 'bad-command' });
    const dir = mkdtempSync(join(tmpdir(), 'zeyvola-helper-'));
    try {
      const noTarget = c.waitFor('ready', 3000);
      c.send({ cmd: 'prepare', outDir: dir }); // no display or window
      await expect(noTarget).rejects.toMatchObject({ code: 'bad-command' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(errors.find((e) => e.type === 'error')).toMatchObject({ code: 'unknown-command', fatal: false });
    const exited = new Promise<number | null>((r) => c.once('exit', (code: number | null) => r(code)));
    c.send({ cmd: 'cancel' });
    expect(await exited).toBe(0);
  });

  it('probes recorded files and reports unreadable ones', async () => {
    const dir = tempDir();
    expect(await probeFiles(REAL, dir)).toEqual([]);
    writeFileSync(join(dir, 'screen.mp4'), 'not a movie');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const [f] = await probeFiles(REAL, dir);
    expect(f).toMatchObject({ name: 'screen.mp4' });
    expect(f!.error).toBeTruthy();
    await expect(probeFiles(REAL, join(dir, 'missing'))).rejects.toMatchObject({ code: 'probe' });
  });
});
