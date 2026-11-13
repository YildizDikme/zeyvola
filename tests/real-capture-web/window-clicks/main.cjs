// Real-use check of click positions in a window recording (macOS), without recording any video:
// the app's own pointer helper, window tracking and cursor log follow this test window while it
// moves and resizes after every click. Clicks come from the mouse (a person or a test driver).
// Usage: run.mjs builds entry.ts and starts this with ZEYVOLA_WC_OUT=<folder> ZEYVOLA_WC_HELPER=<zeyvola-input>.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startTracking } = require('./entry.cjs');

const outDir = process.env.ZEYVOLA_WC_OUT;
const helperPath = process.env.ZEYVOLA_WC_HELPER;
const log = (o) => fs.appendFileSync(path.join(outDir, 'pattern.jsonl'), `${JSON.stringify(o)}\n`);
app.setName('Zeyvola Pencere Testi');

// Window positions and sizes, relative to the main display's work area: moved, resized, both.
const LAYOUTS = [
  { x: 60, y: 40, w: 900, h: 600 },
  { x: 380, y: 120, w: 900, h: 600 },
  { x: 200, y: 260, w: 640, h: 440 },
  { x: 520, y: 60, w: 1000, h: 640 },
  { x: 100, y: 180, w: 760, h: 520 },
  { x: 440, y: 220, w: 820, h: 560 },
];
// Which target to click at each step and with which button (2 = right).
const STEPS = [
  { target: 0, button: 0 }, { target: 3, button: 0 }, { target: 1, button: 2 },
  { target: 2, button: 0 }, { target: 4, button: 0 }, { target: 0, button: 2 },
];

app.whenReady().then(async () => {
  const wa = screen.getPrimaryDisplay().workArea;
  const place = (i) => { const l = LAYOUTS[i % LAYOUTS.length]; win.setBounds({ x: wa.x + l.x, y: wa.y + l.y, width: l.w, height: l.h }); };
  const win = new BrowserWindow({ show: false, backgroundColor: '#101418', title: 'Zeyvola Pencere Testi', webPreferences: { nodeIntegration: true, contextIsolation: false } });
  place(0);
  await win.loadFile(path.join(__dirname, 'index.html'));
  win.show();
  await new Promise((r) => setTimeout(r, 800));
  const tracking = await startTracking({ sourceId: win.getMediaSourceId(), helperPath, cursorFile: path.join(outDir, 'cursor.jsonl') });
  log({ type: 'start', startedAt: tracking.startedAt, sourceId: win.getMediaSourceId() });
  let step = 0;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await tracking.stop();
    fs.writeFileSync(path.join(outDir, 'window-reports.json'), JSON.stringify(tracking.reports));
    log({ type: 'done', steps: step });
  };
  // Closing the window early still leaves a result for the clicks made so far.
  win.on('close', (e) => { if (!finished) { e.preventDefault(); void finish().then(() => app.quit()); } });
  const show = () => win.webContents.send('step', { n: step + 1, of: STEPS.length, ...STEPS[step] });
  ipcMain.on('click', async (_e, c) => {
    // Bounds at the moment of the click, before the window moves on.
    log({ type: 'click', step, wanted: STEPS[step], ...c, bounds: win.getBounds() });
    if (c.button !== STEPS[step].button || c.target !== STEPS[step].target) return; // a stray click is logged, not counted
    step += 1;
    if (step >= STEPS.length) {
      await new Promise((r) => setTimeout(r, 600)); // let the last button-up arrive
      await finish();
      app.quit();
      return;
    }
    place(step);
    await new Promise((r) => setTimeout(r, 250));
    log({ type: 'moved', step, bounds: win.getBounds(), epochMs: Date.now() });
    show();
  });
  show();
});
