// Audit harness main process. Runs audit.js in a hidden window, writes the report to
// $AUDIT_OUT (default: the system temp folder) and quits. Synthetic data only.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const t0 = Date.now();
const outDir = process.env.AUDIT_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'zeyvola-denetim-'));
const out = path.join(outDir, 'report.json');

app.whenReady().then(() => {
  const readyMs = Date.now() - t0;
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  ipcMain.handle('metrics', () => app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage, memMB: Math.round(m.memory.workingSetSize / 1024) })));
  ipcMain.handle('report', (_e, r) => {
    fs.writeFileSync(out, JSON.stringify({ ...r, electronReadyMs: readyMs }, null, 1));
    setTimeout(() => app.quit(), 50);
  });
  win.loadFile(path.join(process.env.AUDIT_BUNDLE_DIR || __dirname, 'index.html'));
  setTimeout(() => { if (!fs.existsSync(out)) fs.writeFileSync(out, JSON.stringify({ timeout: true })); app.quit(); }, 15 * 60 * 1000);
});
