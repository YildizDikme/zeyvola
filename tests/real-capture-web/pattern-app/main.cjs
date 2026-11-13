// The synthetic test pattern (../../real-capture/pattern) in a plain window, for the real-use
// test of the packaged app: Zeyvola records this window's area, the test clicks its targets.
// Writes the pattern's events (clicks with button and position, flashes) and the window's screen
// bounds as JSON lines to ZEYVOLA_PATTERN_LOG. Nothing personal is shown or recorded here.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = process.env.ZEYVOLA_PATTERN_LOG;
if (!out) { console.error('ZEYVOLA_PATTERN_LOG gerekli'); process.exit(2); }
const write = (o) => fs.appendFileSync(out, `${JSON.stringify(o)}\n`);
app.setName('Zeyvola Test Deseni');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const w = Number(process.env.ZEYVOLA_PATTERN_W ?? 1280);
  const h = Number(process.env.ZEYVOLA_PATTERN_H ?? 800);
  const win = new BrowserWindow({
    x: d.workArea.x + 40, y: d.workArea.y + 40, width: w, height: h, useContentSize: true, resizable: false,
    title: 'Zeyvola Test Deseni', backgroundColor: '#101418', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  });
  const bounds = (why) => write({ type: 'bounds', why, epochMs: Date.now(), window: win.getBounds(), content: win.getContentBounds(), display: { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor } });
  // ZEYVOLA_PATTERN_MOVE=1: after every click on the next target the window moves elsewhere, so a
  // window recording is checked against a window that does not stay put.
  const SPOTS = [[40, 40], [260, 120], [120, 220], [320, 60], [80, 160], [220, 200], [40, 40]];
  let spot = 0;
  ipcMain.on('pattern', (_e, ev) => {
    write(ev);
    if (process.env.ZEYVOLA_PATTERN_MOVE === '1' && ev.type === 'click' && ev.inOrder) {
      spot = (spot + 1) % SPOTS.length;
      setTimeout(() => { win.setPosition(d.workArea.x + SPOTS[spot][0], d.workArea.y + SPOTS[spot][1]); bounds('auto-move'); }, 300);
    }
  });
  win.on('moved', () => bounds('moved'));
  await win.loadFile(path.join(__dirname, '..', '..', 'real-capture', 'pattern', 'index.html'));
  bounds('loaded');
});
app.on('window-all-closed', () => app.quit());
