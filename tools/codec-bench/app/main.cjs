// Electron side of tools/codec-bench: an offscreen window runs page.js (WebCodecs encode and
// decode, the same encoder settings as the app's exporter) and asks this process for the
// per-process CPU and memory figures (app.getAppMetrics). Started by tools/codec-bench/run.mjs.
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');

const argv = process.argv;
const config = JSON.parse(argv[argv.indexOf('--bench') + 1]);

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 640, height: 360,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(60);
  ipcMain.handle('config', () => config);
  ipcMain.handle('metrics', () => app.getAppMetrics().map((m) => ({
    type: m.type, pid: m.pid, cpuSeconds: m.cpu.cumulativeCPUUsage ?? null, cpuPercent: m.cpu.percentCPUUsage,
    workingSetKB: m.memory.workingSetSize, peakKB: m.memory.peakWorkingSetSize,
  })));
  ipcMain.handle('info', () => ({
    electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model ?? null, logicalCores: os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30),
    gpuFeatures: app.getGPUFeatureStatus(),
  }));
  ipcMain.on('log', (_e, line) => console.log(line));
  ipcMain.on('done', (_e, result) => {
    writeFileSync(config.out, JSON.stringify(result, null, 2));
    app.exit(result.error ? 1 : 0);
  });
  win.webContents.on('render-process-gone', (_e, d) => { console.error('renderer gone', d.reason); app.exit(1); });
  await win.loadFile(join(__dirname, 'index.html'));
});
