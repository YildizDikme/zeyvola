// Stand-in for the native recording helper in tests: speaks the same line protocol,
// captures nothing. Mode (argv[2]): normal | deny-screen | crash-after-go | silent | interrupt | crash-with-files
//   crash-with-files: on "go" writes a session.jsonl and placeholder files into outDir like the
//   real helper does, adds "mark" lines, and dies on "stop" (before reporting "stopped").
// `--probe-files <dir>` answers with the files listed in <dir>/fake-probe.json.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

const probeAt = process.argv.indexOf('--probe-files');
if (probeAt >= 0) {
  const dir = process.argv[probeAt + 1];
  try {
    send({ type: 'probe', dir, files: JSON.parse(readFileSync(join(dir, 'fake-probe.json'), 'utf8')) });
    process.exit(0);
  } catch (e) {
    send({ type: 'probe', dir, error: String(e.message) });
    process.exit(1);
  }
}

const mode = process.argv[2] ?? 'normal';
let started = 0;
let prepared = null;
const markers = [];
const ticks = () => Math.round(((Date.now() - started) / 1000) * 705_600_000);
const log = (m) => appendFileSync(join(prepared.outDir, 'session.jsonl'), `${JSON.stringify(m)}\n`);

if (mode === 'silent') setInterval(() => undefined, 1000);
else send({ type: 'hello', version: '0.0.0-test', arch: process.arch });

function writeSession() {
  mkdirSync(prepared.outDir, { recursive: true });
  writeFileSync(join(prepared.outDir, 'session.jsonl'), '');
  log({ e: 'session', v: 1, startedAtMs: started, pid: process.pid, helper: 'fake', platform: 'test', fps: 30, cursor: 'cursor.jsonl', meta: prepared.meta });
  log({ e: 'track', kind: 'screen', name: 'screen.mp4', mime: 'video/mp4', startOffsetMs: 0, width: 1920, height: 1080, fps: 30 });
  log({ e: 'track', kind: 'mic', name: 'mic.m4a', mime: 'audio/mp4', startOffsetMs: 12.5, sampleRate: 48000, channels: 1 });
  for (const f of ['screen.mp4', 'mic.m4a', 'cursor.jsonl']) writeFileSync(join(prepared.outDir, f), 'x');
  // What the real probe would measure: the screen up to its last complete 2 s fragment.
  writeFileSync(join(prepared.outDir, 'fake-probe.json'), JSON.stringify([
    { name: 'mic.m4a', kind: 'audio', durationMs: 5980, firstMs: 12.5, samples: 280, sampleRate: 48000, channels: 1 },
    { name: 'screen.mp4', kind: 'video', durationMs: 6000, firstMs: 0, samples: 180, width: 1920, height: 1080 },
  ]));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line);
  switch (c.cmd) {
    case 'prepare':
      prepared = c;
      if (mode === 'deny-screen') send({ type: 'error', code: 'screen-permission', message: 'izin yok', fatal: true });
      else send({ type: 'ready', screenWidth: 1920, screenHeight: 1080, echo: c });
      break;
    case 'go':
      started = Date.now();
      if (mode === 'crash-with-files') writeSession();
      send({ type: 'started', startedAtMs: started });
      send({ type: 'status', elapsedMs: 0, micLevel: 0.25, dropped: 0 });
      if (mode === 'crash-after-go') setTimeout(() => process.exit(3), 20);
      if (mode === 'interrupt') setTimeout(() => send({ type: 'interrupted', code: 'screen-stopped', message: 'durdu' }), 20);
      break;
    case 'mark':
      markers.push(ticks());
      if (mode === 'crash-with-files') log({ e: 'mark', t: markers.at(-1) });
      break;
    case 'stop':
      if (mode === 'crash-with-files') process.exit(3);
      send({
        type: 'stopped', durationMs: 2000, cursor: 'cursor.jsonl', markers, hasClicks: true, clicks: 2, cursorSamples: 240,
        files: [
          { kind: 'screen', name: 'screen.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 60, startOffsetMs: 0, durationMs: 2000 },
          { kind: 'camera', name: 'camera.mp4', mime: 'video/mp4', width: 1280, height: 720, fps: 30, startOffsetMs: 40, durationMs: 1960 },
          { kind: 'mic', name: 'mic.m4a', mime: 'audio/mp4', sampleRate: 48000, channels: 1, startOffsetMs: 12.5 },
          { kind: 'system', name: 'system.m4a', mime: 'audio/mp4', startOffsetMs: 0, error: 'yazılamadı' },
        ],
      });
      break;
    case 'cancel':
      send({ type: 'cancelled' });
      process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
