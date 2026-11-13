// Measures sync marks the way the app sees them: in Chromium, with the runtime it is started
// with (chromium-probe.mjs starts it with official Electron + Electron's FFmpeg without
// proprietary codecs, i.e. what the packages contain).
//
//   <electron> <this folder> --out <result.json> --file <path>[:x,y,w,h[;x,y,w,h...]] ...
//
// Audio (decodeAudioData, as the app's export mixer): start times of the 1 kHz test tone, with
// the same 5 ms Goertzel windows and thresholds as media-probe.swift. Video (<video>, as the
// preview and export compositor): times each given region's brightness jumps up, from each
// presented frame's media time (requestVideoFrameCallback, real-time playback). `rises` is the
// first region's; `regions` lists every region's.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const argv = process.argv;
const out = argv[argv.indexOf('--out') + 1];
const files = argv.flatMap((a, i) => (a === '--file' ? [argv[i + 1]] : [])).map((spec) => {
  const m = /^(.*?)(?::((?:[\d.]+,[\d.]+,[\d.]+,[\d.]+;?)+))?$/.exec(spec);
  return { path: m[1], regions: m[2] ? m[2].split(';').filter(Boolean).map((r) => r.split(',').map(Number)) : null };
});

async function page(items) {
  const audioOnsets = (ch, rate) => {
    const window = Math.round(rate * 0.005);
    const coeff = 2 * Math.cos((2 * Math.PI * 1000) / rate);
    const series = [];
    for (let i = 0; i + window <= ch.length; i += window) {
      let s1 = 0, s2 = 0, energy = 0;
      for (let k = i; k < i + window; k++) { const x = ch[k]; energy += x * x; const s0 = x + coeff * s1 - s2; s2 = s1; s1 = s0; }
      const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (window * window);
      series.push([i / rate, power, energy > 0 ? (2 * power) / (energy / window) : 0]);
    }
    const max = Math.max(0, ...series.map((x) => x[1]));
    const onsets = [];
    let prev = false;
    for (const [t, p, purity] of series) {
      const on = 2 * Math.sqrt(p) >= 0.003 && purity >= 0.5 && p >= max * 0.1;
      if (on && !prev && (!onsets.length || t - onsets[onsets.length - 1] >= 0.5)) onsets.push(Math.round(t * 1e4) / 1e4);
      prev = on;
    }
    return onsets;
  };
  const results = [];
  for (const it of items) {
    if (it.kind === 'audio') {
      try {
        const bin = Uint8Array.from(atob(it.base64), (c) => c.charCodeAt(0));
        const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bin.buffer);
        const mono = new Float32Array(buf.length);
        for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels; }
        results.push({ file: it.name, kind: 'audio', duration: buf.duration, sampleRate: buf.sampleRate, toneOnsets: audioOnsets(mono, buf.sampleRate) });
      } catch (e) { results.push({ file: it.name, kind: 'audio', error: String(e) }); }
      continue;
    }
    const v = document.createElement('video');
    v.muted = true;
    v.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px';
    document.body.appendChild(v); // frames are only presented (and reported) for a rendered element
    v.src = it.url;
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error(v.error?.message ?? 'video error')); });
      if (!Number.isFinite(v.duration)) {
        // A WebM written by MediaRecorder has no length in its header; it is known after a seek to the end.
        await new Promise((res) => { v.ondurationchange = () => { if (Number.isFinite(v.duration)) res(); }; setTimeout(res, 10_000); v.currentTime = 1e9; });
        await new Promise((res) => { v.onseeked = res; v.currentTime = 0; });
      }
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
      const g = c.getContext('2d', { willReadFrequently: true });
      const boxes = it.regions.map(([rx, ry, rw, rh]) => [Math.round(rx * v.videoWidth), Math.round(ry * v.videoHeight), Math.max(1, Math.round(rw * v.videoWidth)), Math.max(1, Math.round(rh * v.videoHeight))]);
      const all = boxes.map(() => []);
      let presented = 0;
      await new Promise((resolve) => {
        const step = (_now, meta) => {
          g.drawImage(v, 0, 0);
          boxes.forEach((box, b) => {
            const d = g.getImageData(box[0], box[1], box[2], box[3]).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 16) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            all[b].push([meta.mediaTime, sum / (d.length / 16)]);
          });
          presented = meta.presentedFrames;
          if (!v.ended) v.requestVideoFrameCallback(step);
        };
        v.requestVideoFrameCallback(step);
        v.onended = () => setTimeout(resolve, 100);
        setTimeout(resolve, (v.duration * 2 + 10) * 1000); // never hang
        void v.play();
      });
      const risesOf = (series) => {
        const vals = series.map((x) => x[1]);
        const lo = Math.min(...vals), hi = Math.max(...vals), mid = (lo + hi) / 2;
        const rises = [];
        for (let i = 1; i < series.length; i++) {
          if (hi - lo >= 60 && series[i - 1][1] < mid && series[i][1] >= mid && (!rises.length || series[i][0] - rises[rises.length - 1] >= 0.3)) rises.push(Math.round(series[i][0] * 1e4) / 1e4);
        }
        return rises;
      };
      const regions = all.map((series, b) => ({ region: it.regions[b], rises: risesOf(series) }));
      results.push({ file: it.name, kind: 'video', duration: v.duration, framesSeen: all[0].length, presentedFrames: presented, rises: regions[0].rises, regions });
    } catch (e) { results.push({ file: it.name, kind: 'video', error: String(e) }); }
    v.removeAttribute('src'); v.load(); v.remove();
  }
  return results;
}

app.whenReady().then(async () => {
  const items = files.map((f) => {
    const name = f.path.split('/').pop();
    const audio = /\.(m4a|weba|wav|ogg|opus)$/i.test(f.path) && !f.regions;
    return audio ? { name, kind: 'audio', base64: readFileSync(f.path).toString('base64') } : { name, kind: 'video', url: pathToFileURL(f.path).href, regions: f.regions ?? [[0.89, 0.05, 0.08, 0.12]] };
  });
  // Offscreen rendering: nothing appears on screen, yet video frames are composited and presented.
  const win = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  const html = join(app.getPath('temp'), `zeyvola-chromium-probe-${process.pid}.html`);
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><title>probe</title>');
  await win.loadFile(html);
  const results = await win.webContents.executeJavaScript(`(${page.toString()})(${JSON.stringify(items)})`, true);
  writeFileSync(out, `${JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, results }, null, 1)}\n`);
  app.exit(0);
}).catch((e) => { process.stderr.write(String(e?.stack ?? e)); app.exit(1); });
