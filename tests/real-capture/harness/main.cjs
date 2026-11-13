// Real capture harness. Runs inside the development bundle "Zeyvola (geliştirme)" so macOS
// attributes permissions to Zeyvola (not to a terminal). Shows the synthetic test pattern,
// drives the real Swift helper through the app's own HelperClient and writes report.json.
// Recordings go to config.out (a private temp folder), never into the repository.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { HelperClient, prepareCommand, recordingResult } = require('./helper-client.cjs');
const { ProjectStore, parseSessionLog, probeFiles, recoverAbandoned, SESSION_FILE } = require('./recovery.cjs');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const report = { startedAt: new Date().toISOString(), electron: process.versions.electron, arch: process.arch, scenarios: [], errors: [] };
const pattern = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = () => fs.writeFileSync(path.join(cfg.out, 'report.json'), JSON.stringify(report, null, 1));

function sample(pid) {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', '%cpu=,rss=', '-p', String(pid)], (err, out) => {
      if (err) return resolve(null);
      const [cpu, rss] = out.trim().split(/\s+/).map(Number);
      resolve({ cpu, rssMB: Math.round(rss / 1024) });
    });
  });
}

async function access() {
  const c = new HelperClient(cfg.helper);
  await c.open();
  const reply = c.waitFor('access', 10 * 60_000); // the user may be answering the system dialogs
  c.send({ cmd: 'request-access', screen: true, camera: cfg.camera, mic: cfg.mic });
  const r = await reply;
  c.close(500);
  return r;
}

/** What the app does at its next start: find recordings missing from their projects and add them. */
async function recoverLikeTheApp(store, sc, project, recordingId, out) {
  const t = Date.now();
  const entries = [];
  for (const { id, dir } of await store.entries()) entries.push({ id, dir, recordingIds: new Set(Object.keys((await store.read(id)).recordings)) });
  const errors = [];
  const results = await recoverAbandoned(entries, {
    probe: (dir) => probeFiles(cfg.helper, dir),
    hasRecording: async (p, id) => id in (await store.read(p)).recordings,
    appendRecording: (p, rec) => store.appendRecording(p, rec),
    platform: `${process.platform}-${process.arch}`,
    fallbackLabel: 'Kurtarılan kayıt',
  }, (dir, e) => errors.push(`${dir}: ${e.message}`));
  const ms = Date.now() - t;
  const saved = await store.read(project.id); // parsed and validated like the editor does
  const recording = saved.recordings[recordingId] ?? null;
  // A second start must not add it again (even when the folder is looked at once more).
  const again = await recoverAbandoned([{ id: project.id, dir: project.dir, recordingIds: new Set() }], {
    probe: (dir) => probeFiles(cfg.helper, dir), hasRecording: async (p, id) => id in (await store.read(p)).recordings,
    appendRecording: (p, rec) => store.appendRecording(p, rec), platform: `${process.platform}-${process.arch}`,
  });
  if (recording) {
    // Same shape as a normal stop writes, so `ZEYVOLA_REAL_RECORDING_DIR=<dir> pnpm smoke` can open it.
    const { platform, ...capture } = recording.capture;
    fs.writeFileSync(path.join(out, 'recording.json'), JSON.stringify({ sources: recording.sources, cursorFile: recording.cursorFile, durationTicks: recording.duration, capture, markers: recording.markers }, null, 1));
  }
  return {
    ms, results, errors, again: again.map((r) => r.status === 'skipped' ? r.reason : r.status),
    projectFile: path.join(project.dir, 'project.json'), recordingsInProject: Object.keys(saved.recordings).length,
    segments: saved.sequence.segments.filter((s) => s.recordingId === recordingId).map((s) => ({ start: s.sourceStart, end: s.sourceEnd })),
    recording, session: parseSessionLog(fs.readFileSync(path.join(out, SESSION_FILE), 'utf8')), probed: await probeFiles(cfg.helper, out),
  };
}

async function scenario(sc, win) {
  // Scenarios that test recovery record into a real project folder, like the app does.
  let store = null, project = null, recordingId = sc.name, out = path.join(cfg.out, sc.name);
  if (sc.recover) {
    store = new ProjectStore(path.join(cfg.out, 'projeler'));
    await store.init();
    project = await store.create(`Kurtarma ${sc.name}`);
    recordingId = `rec_${require('crypto').randomUUID()}`;
    out = await store.mediaDir(project.id, recordingId);
  }
  fs.mkdirSync(out, { recursive: true });
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const displayBounds = { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height };
  const isWindow = sc.target === 'window';
  const target = isWindow
    ? { kind: 'window', sourceId: win.getMediaSourceId(), label: 'Zeyvola Test Deseni' }
    : { kind: 'region', sourceId: `screen:${d.id}:0`, displayId: String(d.id), label: 'Test bölgesi', region: { x: b.x - d.bounds.x, y: b.y - d.bounds.y, w: b.width, h: b.height } };
  const targetBounds = isWindow ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: b.x, y: b.y, w: b.width, h: b.height };
  const args = {
    config: {
      target, cameraDeviceId: sc.camera ? 'default' : null, cameraLabel: null, micDeviceId: sc.mic ? 'default' : null, micLabel: null,
      systemAudio: !!sc.systemAudio, fps: sc.fps, quality: sc.quality, countdown: 0, backend: 'native',
    },
    outDir: out, recordingId, targetBounds, displayBounds, scaleFactor: d.scaleFactor,
  };
  const cmd = prepareCommand(args, process.pid);
  cmd.excludePid = null; // the pattern is our own window and must be recorded
  // The test tone comes from this app; without this, system audio would rightly leave it out.
  if (sc.excludeOwnAudio === false) cmd.excludeOwnAudio = false;
  const r = { name: sc.name, excludeOwnAudio: sc.excludeOwnAudio, target: sc.target, fps: sc.fps, quality: sc.quality, camera: !!sc.camera, mic: !!sc.mic, systemAudio: !!sc.systemAudio,
    windowBounds: b, display: { id: d.id, bounds: displayBounds, scaleFactor: d.scaleFactor }, out, timings: {}, events: [], usage: [], statuses: 0, maxDropped: 0 };
  const c = new HelperClient(cfg.helper);
  c.on('message', (m) => {
    if (m.type === 'status') { r.statuses++; r.maxDropped = Math.max(r.maxDropped, m.dropped); r.lastMicLevel = m.micLevel; }
    else r.events.push({ ...m, atMs: Date.now() });
  });
  let exited = null;
  c.on('exit', (code) => { exited = code; });
  const t0 = Date.now();
  try {
    r.hello = await c.open();
    const ready = c.waitFor('ready', 120_000);
    c.send(cmd);
    r.ready = await ready;
    r.timings.prepareMs = Date.now() - t0;
    await sleep(500);
    const t1 = Date.now();
    const started = c.waitFor('started', 10_000);
    c.send({ cmd: 'go' });
    r.started = await started;
    r.timings.goMs = Date.now() - t1;
    r.patternFrom = pattern.length;
    const pid = c.pid;
    const usageTimer = setInterval(async () => { const u = pid && (await sample(pid)); if (u) r.usage.push({ t: Date.now() - t1, ...u }); }, 1000);
    const pauses = [];
    for (const step of sc.steps) {
      const at = Date.now() - t1;
      if (step.wait) await sleep(step.wait * 1000);
      else if (step.do === 'mark') { c.send({ cmd: 'mark' }); r.marksSent = (r.marksSent ?? 0) + 1; }
      else if (step.do === 'pause') { c.send({ cmd: 'pause' }); pauses.push({ from: at }); }
      else if (step.do === 'resume') { c.send({ cmd: 'resume' }); pauses[pauses.length - 1].to = at; }
      else if (step.do === 'clicks') {
        const until = Date.now() + step.timeout * 1000;
        win.webContents.executeJavaScript(`document.getElementById('hint').textContent = 'KAYIT SÜRÜYOR · sarı çerçeveli hedefe tıklayın (1 → 6)'`).catch(() => undefined);
        while (pattern.slice(r.patternFrom).filter((e) => e.type === 'click' && e.inOrder).length < step.count && Date.now() < until) await sleep(200);
        r.clickWaitMs = Date.now() - t1 - at;
      } else if (step.do === 'kill') {
        r.killedAtMs = Date.now() - t1;
        process.kill(pid, 'SIGKILL');
        await sleep(1000);
      } else if (step.do === 'closeStdin') {
        const stopped = c.waitFor('stopped', 60_000);
        const ts = Date.now();
        c.close(60_000);
        r.stopped = await stopped;
        r.timings.stopMs = Date.now() - ts;
      } else if (step.do === 'stop') {
        const stopped = c.waitFor('stopped', 60_000);
        const ts = Date.now();
        c.send({ cmd: 'stop' });
        r.stopped = await stopped;
        r.timings.stopMs = Date.now() - ts;
        c.close();
      }
    }
    clearInterval(usageTimer);
    // What the app would store for this recording (read by the smoke test's real-recording step).
    if (r.stopped) fs.writeFileSync(path.join(out, 'recording.json'), JSON.stringify(recordingResult(r.stopped, args, 'native-macos'), null, 1));
    r.pauses = pauses;
    r.wallMs = Date.now() - t1;
  } catch (e) {
    r.error = `${e.code ?? ''} ${e.message}`;
    c.close(500);
  }
  await sleep(1500);
  r.exitCode = exited;
  if (sc.recover && !r.error) {
    try { r.recovery = await recoverLikeTheApp(store, sc, project, recordingId, out); } catch (e) { r.recovery = { error: String(e?.stack ?? e) }; }
  }
  r.stderr = c.stderrTail(30);
  r.pattern = pattern.slice(r.patternFrom ?? pattern.length);
  r.files = fs.readdirSync(out).map((f) => ({ name: f, bytes: fs.statSync(path.join(out, f)).size }));
  return r;
}

app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    // Bottom-left and above everything (also over full-screen apps), away from the
    // notification corner, so a region recording sees only the synthetic pattern.
    const W = Math.min(960, d.workArea.width - 80), H = Math.round(W * 0.625);
    const win = new BrowserWindow({
      x: d.workArea.x + 40, y: d.workArea.y + d.workArea.height - H - 40, width: W, height: H, frame: false, resizable: false, alwaysOnTop: true,
      acceptFirstMouse: true, title: 'Zeyvola Test Deseni', backgroundColor: '#101418',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', sandbox: true, contextIsolation: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    ipcMain.on('pattern', (_e, ev) => pattern.push(ev));
    await win.loadFile(path.join(__dirname, 'pattern', 'index.html'));
    report.patternWindow = win.getBounds();
    report.permissions = await access();
    write();
    if (report.permissions.screen !== 'granted') {
      report.needsScreenPermission = true;
    } else {
      for (const sc of cfg.scenarios) {
        report.scenarios.push(await scenario(sc, win));
        write();
      }
    }
  } catch (e) {
    report.errors.push(String(e?.stack ?? e));
  }
  report.pattern = pattern;
  report.finishedAt = new Date().toISOString();
  write();
  setTimeout(() => app.quit(), 300);
});
