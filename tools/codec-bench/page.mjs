// VP8 / VP9 comparison, run inside Electron by tools/codec-bench/run.mjs (bundled with esbuild).
//
// Content: a deterministic synthetic screen recording (editor window, small UI text, code that
// is typed, then scrolls, then the whole screen zooms in and out like the app's auto zoom, a
// photo-like noisy image and a moving cursor). Each segment is 2 s: static, scroll, zoom.
// Encoder settings are the exporter's (apps/desktop/src/renderer/export/exporter.ts): VBR,
// latencyMode "quality", key frame every 2 s, "prefer-hardware" then "no-preference",
// the "high" quality bitrate, Opus 192 kb/s. Files are muxed with the app's own writers.
//
// Quality is measured on the luma plane: the decoded frame's Y plane (VideoFrame.copyTo) against
// the source frame converted with the RGB→Y matrix the encoder actually used (found per codec
// from flat colour patches), so no display conversion is involved.
import { Mp4Writer, WebmWriter } from '../../packages/media-web/src/index';

const req = window.require;
const { ipcRenderer } = req('electron');
const fs = req('node:fs');
const path = req('node:path');
const log = (m) => ipcRenderer.send('log', m);

// ---------- content ----------
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WORDS = 'the of timeline export render frame zoom camera cursor audio track scene layer project codec preview clip region blur opacity keyframe easing spring motion screen window record pause resume trim split speed volume fade caption title theme shadow padding radius background gradient'.split(' ');
const KEYWORDS = ['const', 'let', 'function', 'return', 'await', 'if', 'for', 'import', 'export', 'new'];

function makeAssets(W, H) {
  const s = H / 1080;
  const r = mulberry32(42);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const side = Array.from({ length: 40 }, () => `${pick(WORDS)}-${pick(WORDS)}.ts`);
  const code = Array.from({ length: 400 }, () => {
    const indent = Math.floor(r() * 4);
    const toks = [];
    const n = 2 + Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const k = r();
      toks.push(k < 0.2 ? { t: pick(KEYWORDS), c: '#c792ea' } : k < 0.35 ? { t: `'${pick(WORDS)}'`, c: '#c3e88d' } : k < 0.45 ? { t: String(Math.floor(r() * 9000)), c: '#f78c6c' } : { t: `${pick(WORDS)}${r() < 0.4 ? '(' : ''}`, c: '#d6deeb' });
    }
    return { indent, toks };
  });
  const typing = 'const zoom = spring(target, { stiffness: 170, damping: 26 });';
  const meas = new OffscreenCanvas(8, 8).getContext('2d');
  meas.font = `${11 * s}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const ww = W - 80 * s;
  const panel = { x: 40 * s + 240 * s + (ww - 240 * s) * 0.56 };
  const rw = 40 * s + ww - panel.x;
  const para = [];
  for (let p = 0; p < 6; p++) {
    let line = '';
    for (let i = 0; i < 70; i++) {
      const w = pick(WORDS);
      if (meas.measureText(`${line} ${w}`).width > rw - 48 * s) { para.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    para.push(line, '');
  }
  // Photo-like area: gradient, shapes and per-pixel noise (hard to compress, like photos on screen).
  const pw = Math.round(rw - 48 * s), ph = Math.round(220 * s);
  const photo = new OffscreenCanvas(pw, ph);
  const g = photo.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, ph);
  grad.addColorStop(0, '#6aa9e9'); grad.addColorStop(0.6, '#f3d9a4'); grad.addColorStop(1, '#3f6b3a');
  g.fillStyle = grad; g.fillRect(0, 0, pw, ph);
  for (let i = 0; i < 12; i++) { g.fillStyle = `hsl(${100 + r() * 60},40%,${25 + r() * 20}%)`; g.beginPath(); g.ellipse(r() * pw, ph * (0.75 + r() * 0.3), pw * (0.1 + r() * 0.2), ph * (0.1 + r() * 0.2), 0, 0, Math.PI * 2); g.fill(); }
  const img = g.getImageData(0, 0, pw, ph);
  for (let i = 0; i < img.data.length; i += 4) { const n = (r() - 0.5) * 36; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
  g.putImageData(img, 0, 0);
  return { s, side, code, typing, para, photo };
}

/** Layout shared by drawing and the measured regions (output pixels). */
function layout(W, H) {
  const s = H / 1080;
  const wx = 40 * s, wy = 40 * s, ww = W - 80 * s, wh = H - 80 * s;
  const sy = wy + 36 * s, sw = 240 * s, sh = wh - 36 * s;
  const px = wx + sw, pw = (ww - sw) * 0.56;
  const rx = px + pw, rw = wx + ww - rx;
  return { s, wx, wy, ww, wh, sy, sw, sh, px, pw, rx, rw,
    regions: {
      smallText: [rx + 24 * s, sy + 56 * s, rw - 48 * s, 360 * s],
      code: [px, sy, pw, sh],
    } };
}

const SANS = '-apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = 'Menlo, Consolas, "Courier New", monospace';

function drawFrame(g, i, fps, W, H, A) {
  const L = layout(W, H);
  const { s } = L;
  const t = i / fps;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#dfe3ea'; g.fillRect(0, 0, W, H);
  const z = t >= 4 ? 1 + 0.6 * Math.sin((Math.PI * (t - 4)) / 2) ** 2 : 1;
  const cx = W * 0.42, cy = H * 0.45;
  g.setTransform(z, 0, 0, z, cx - cx * z, cy - cy * z);
  // Window and title bar.
  g.fillStyle = '#ffffff'; g.fillRect(L.wx, L.wy, L.ww, L.wh);
  g.fillStyle = '#f2f2f5'; g.fillRect(L.wx, L.wy, L.ww, 36 * s);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, k) => { g.fillStyle = c; g.beginPath(); g.arc(L.wx + (20 + k * 20) * s, L.wy + 18 * s, 6 * s, 0, Math.PI * 2); g.fill(); });
  g.fillStyle = '#3a3d44'; g.font = `${13 * s}px ${SANS}`; g.textBaseline = 'middle';
  g.fillText('zoom-engine.ts — Project', L.wx + L.ww / 2 - 80 * s, L.wy + 18 * s);
  // Sidebar.
  g.fillStyle = '#f6f7f9'; g.fillRect(L.wx, L.sy, L.sw, L.sh);
  g.textBaseline = 'top';
  for (let r = 0; r < A.side.length; r++) {
    const y = L.sy + 14 * s + r * 26 * s;
    if (y > L.sy + L.sh - 26 * s) break;
    if (r === 7) { g.fillStyle = '#d6e4ff'; g.fillRect(L.wx + 8 * s, y - 3 * s, L.sw - 16 * s, 24 * s); }
    g.fillStyle = '#2b2f36'; g.font = `${13 * s}px ${SANS}`;
    g.fillText(A.side[r], L.wx + 24 * s, y + 2 * s);
  }
  // Code panel: typed (0–2 s), scrolling (2–4 s), still (4–6 s, zoom).
  g.fillStyle = '#1e1f24'; g.fillRect(L.px, L.sy, L.pw, L.sh);
  const lh = 20 * s;
  const scroll = (t < 2 ? 0 : t < 4 ? t - 2 : 2) * 300 * s;
  g.save(); g.beginPath(); g.rect(L.px, L.sy, L.pw, L.sh); g.clip();
  g.font = `${13 * s}px ${MONO}`;
  const first = Math.floor(scroll / lh);
  for (let l = first; l < first + L.sh / lh + 2 && l < A.code.length; l++) {
    const y = L.sy + 10 * s + l * lh - scroll;
    g.fillStyle = '#5c6370'; g.fillText(String(l + 1).padStart(3, ' '), L.px + 10 * s, y);
    let x = L.px + 56 * s + A.code[l].indent * 24 * s;
    const toks = l === 30 ? [{ t: A.typing.slice(0, Math.min(A.typing.length, Math.floor(t * 30))) + (Math.floor(t * 2) % 2 ? '▍' : ''), c: '#ffffff' }] : A.code[l].toks;
    for (const tok of toks) { g.fillStyle = tok.c; g.fillText(tok.t, x, y); x += g.measureText(`${tok.t} `).width; }
  }
  g.restore();
  // Document panel: heading, small paragraph text, photo.
  const [tx, ty] = L.regions.smallText;
  g.fillStyle = '#111318'; g.font = `600 ${22 * s}px ${SANS}`;
  g.fillText('Export settings', tx, L.sy + 18 * s);
  g.fillStyle = '#4a4f59'; g.font = `${11 * s}px ${SANS}`;
  A.para.forEach((line, k) => g.fillText(line, tx, ty + k * 15 * s));
  g.drawImage(A.photo, tx, ty + A.para.length * 15 * s + 12 * s);
  // Cursor.
  const mx = L.wx + L.ww * (0.5 + 0.35 * Math.sin(t * 1.3)), my = L.wy + L.wh * (0.5 + 0.35 * Math.sin(t * 0.9 + 1));
  g.fillStyle = '#000'; g.strokeStyle = '#fff'; g.lineWidth = 1.5 * s;
  g.beginPath(); g.moveTo(mx, my); g.lineTo(mx, my + 18 * s); g.lineTo(mx + 5 * s, my + 13 * s); g.lineTo(mx + 12 * s, my + 13 * s); g.closePath(); g.fill(); g.stroke();
}

// ---------- helpers ----------
function memorySink() {
  let buf = new Uint8Array(1 << 22);
  let len = 0;
  const ensure = (n) => { if (n <= buf.length) return; let m = buf.length; while (m < n) m *= 2; const nb = new Uint8Array(m); nb.set(buf.subarray(0, len)); buf = nb; };
  const sink = async (data, pos) => {
    const at = pos === null ? len : pos;
    ensure(at + data.length); buf.set(data, at); len = Math.max(len, at + data.length);
  };
  return { sink, bytes: () => buf.subarray(0, len) };
}

const metrics = () => ipcRenderer.invoke('metrics');
function cpuDelta(before, after) {
  const out = {};
  for (const a of after) {
    const b = before.find((x) => x.pid === a.pid);
    const d = a.cpuSeconds != null ? a.cpuSeconds - (b?.cpuSeconds ?? 0) : null;
    out[a.type] = (out[a.type] ?? 0) + (d ?? 0);
  }
  return out;
}

/** Samples percent CPU per process type while a pass runs. */
function sampler() {
  const peaks = {}; const sums = {}; let n = 0;
  let stop = false;
  const loop = (async () => {
    await metrics(); // first percentCPUUsage reading is 0
    while (!stop) {
      await new Promise((r) => setTimeout(r, 500));
      const m = await metrics();
      const by = {};
      for (const x of m) { by[x.type] = (by[x.type] ?? 0) + x.cpuPercent; peaks[`${x.type}_ws_MB`] = Math.max(peaks[`${x.type}_ws_MB`] ?? 0, Math.round(x.workingSetKB / 1024)); }
      for (const [k, v] of Object.entries(by)) { peaks[k] = Math.max(peaks[k] ?? 0, v); sums[k] = (sums[k] ?? 0) + v; }
      n++;
    }
  })();
  return async () => { stop = true; await loop; const avg = {}; for (const [k, v] of Object.entries(sums)) avg[k] = +(v / Math.max(1, n)).toFixed(1); for (const k of Object.keys(peaks)) peaks[k] = +(+peaks[k]).toFixed(1); return { avgPercent: avg, peak: peaks }; };
}

function vp9String(W, H) { return W * H > 2_500_000 ? 'vp09.00.51.08' : 'vp09.00.41.08'; }
const codecStr = (codec, W, H) => (codec === 'vp8' ? 'vp8' : vp9String(W, H));

async function pickConfig(codec, W, H, fps, bitrate) {
  const base = { codec: codecStr(codec, W, H), width: W, height: H, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
  const support = {};
  for (const hw of ['prefer-hardware', 'prefer-software']) {
    try { support[hw] = (await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: hw })).supported; } catch { support[hw] = false; }
  }
  for (const hw of ['prefer-hardware', 'no-preference']) {
    const cfg = { ...base, hardwareAcceleration: hw };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return { config: s.config ?? cfg, accel: hw, support }; } catch { /* next */ }
  }
  return { config: null, accel: null, support };
}

async function encodeAll(config, frames, fps, W, H, A, onFrame) {
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext('2d');
  const chunks = [];
  let err = null;
  const enc = config ? new VideoEncoder({
    output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, ts: c.timestamp, dur: c.duration, key: c.type === 'key' }); },
    error: (e) => { err = e; },
  }) : null;
  enc?.configure(config);
  const frameUs = 1e6 / fps;
  const gop = fps * 2;
  for (let i = 0; i < frames; i++) {
    if (err) throw err;
    drawFrame(g, i, fps, W, H, A);
    const f = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
    if (enc) {
      enc.encode(f, { keyFrame: i % gop === 0 });
      f.close();
      while (enc.encodeQueueSize > 6) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    } else {
      f.close();
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    onFrame?.(i);
  }
  if (enc) { await enc.flush(); enc.close(); }
  if (err) throw err;
  return chunks;
}

/** Y plane of a decoded frame (I420 or NV12; plane 0 either way). */
async function lumaOf(frame) {
  const rect = frame.visibleRect;
  const buf = new Uint8Array(frame.allocationSize({ rect }));
  const lay = await frame.copyTo(buf, { rect });
  const W = rect.width, H = rect.height;
  const y = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) y.set(buf.subarray(lay[0].offset + r * lay[0].stride, lay[0].offset + r * lay[0].stride + W), r * W);
  return { y, W, H, format: frame.format, colorSpace: frame.colorSpace?.toJSON?.() ?? null };
}

const MATRICES = {
  'bt601-limited': [0.299, 0.114, false], 'bt601-full': [0.299, 0.114, true],
  'bt709-limited': [0.2126, 0.0722, false], 'bt709-full': [0.2126, 0.0722, true],
};
function rgbaToY(data, W, H, m) {
  const [kr, kb, full] = MATRICES[m];
  const kg = 1 - kr - kb;
  const y = new Float32Array(W * H);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    const v = kr * data[p] + kg * data[p + 1] + kb * data[p + 2];
    y[i] = full ? v : 16 + (219 * v) / 255;
  }
  return y;
}

/** Which RGB→Y conversion the encoder applied: flat patches, high bitrate, key frame. */
async function calibrate(codec) {
  const W = 512, H = 256;
  const colors = [[255, 255, 255], [0, 0, 0], [128, 128, 128], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [64, 160, 220]];
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d');
  colors.forEach((col, k) => { g.fillStyle = `rgb(${col.join(',')})`; g.fillRect((k % 4) * 128, Math.floor(k / 4) * 128, 128, 128); });
  const { config } = await pickConfig(codec, W, H, 30, 8e6);
  const chunks = [];
  const enc = new VideoEncoder({ output: (ch) => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); chunks.push(new EncodedVideoChunk({ type: ch.type, timestamp: ch.timestamp, data: d })); }, error: () => undefined });
  enc.configure(config);
  for (let i = 0; i < 3; i++) { const f = new VideoFrame(c, { timestamp: i * 33333 }); enc.encode(f, { keyFrame: i === 0 }); f.close(); }
  await enc.flush(); enc.close();
  let luma = null;
  const dec = new VideoDecoder({ output: (f) => { if (!luma) luma = lumaOf(f).finally(() => f.close()); else f.close(); }, error: () => undefined });
  dec.configure({ codec: config.codec, codedWidth: W, codedHeight: H });
  dec.decode(chunks[0]);
  await dec.flush(); dec.close();
  const L = await luma;
  const measured = colors.map((_, k) => {
    let sum = 0, n = 0;
    const x0 = (k % 4) * 128 + 32, y0 = Math.floor(k / 4) * 128 + 32;
    for (let yy = y0; yy < y0 + 64; yy++) for (let xx = x0; xx < x0 + 64; xx++) { sum += L.y[yy * L.W + xx]; n++; }
    return sum / n;
  });
  const errors = {};
  for (const m of Object.keys(MATRICES)) {
    const pred = colors.map((col) => rgbaToY(new Uint8ClampedArray([...col, 255]), 1, 1, m)[0]);
    errors[m] = +Math.max(...pred.map((p, k) => Math.abs(p - measured[k]))).toFixed(2);
  }
  const best = Object.entries(errors).sort((a, b) => a[1] - b[1])[0][0];
  return { matrix: best, maxErrorByMatrix: errors, decodedFormat: L.format, decodedColorSpace: L.colorSpace };
}

function psnr(a, b, W, rect) {
  const [x0, y0, w, h] = rect.map(Math.round);
  let se = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const d = a[y * W + x] - b[y * W + x]; se += d * d; n++; }
  const mse = se / n;
  return { mse, psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse) };
}
function ssim8(a, b, W, H) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let by = 0; by + 8 <= H; by += 8) for (let bx = 0; bx + 8 <= W; bx += 8) {
    let ma = 0, mb = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) { ma += a[y * W + x]; mb += b[y * W + x]; }
    ma /= 64; mb /= 64;
    let va = 0, vb = 0, cov = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) { const da = a[y * W + x] - ma, db = b[y * W + x] - mb; va += da * da; vb += db * db; cov += da * db; }
    va /= 63; vb /= 63; cov /= 63;
    sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    n++;
  }
  return sum / n;
}
/**
 * Gradient-magnitude similarity in a region (mean over pixels, 1 = edges identical): how well
 * text edges survive. Unlike a plain gradient sum it is not raised by ringing artifacts.
 */
function edgeSimilarity(dec, src, W, rect) {
  const [x0, y0, w, h] = rect.map(Math.round);
  const c = 170; // 0.0026 · 255², the usual constant for 8-bit images
  let sum = 0, n = 0;
  for (let y = y0 + 1; y < y0 + h - 1; y++) for (let x = x0 + 1; x < x0 + w - 1; x++) {
    const i = y * W + x;
    const gd = Math.hypot(dec[i + 1] - dec[i - 1], dec[i + W] - dec[i - W]);
    const gs = Math.hypot(src[i + 1] - src[i - 1], src[i + W] - src[i - W]);
    sum += (2 * gd * gs + c) / (gd * gd + gs * gs + c);
    n++;
  }
  return sum / n;
}

async function measure(job, chunks, matrix, A, cropAt, crops) {
  const { W, H, fps } = job;
  const L = layout(W, H);
  const step = fps / 3;
  const want = new Set();
  for (let i = 0; i < job.frames; i += step) want.add(i);
  for (const i of cropAt) want.add(i);
  const src = new OffscreenCanvas(W, H);
  const sg = src.getContext('2d', { willReadFrequently: true });
  const view = new OffscreenCanvas(W, H);
  const vg = view.getContext('2d', { willReadFrequently: true });
  const samples = [];
  let chain = Promise.resolve();
  let held = 0; // decoded frames kept open until measured; the decoder's frame pool is small
  let err = null;
  const dec = new VideoDecoder({
    output: (f) => {
      const i = Math.round((f.timestamp * fps) / 1e6);
      if (!want.has(i)) { f.close(); return; }
      held++;
      if (cropAt.includes(i)) vg.drawImage(f, 0, 0);
      const cropData = cropAt.includes(i) ? vg.getImageData(...L.regions.smallText.map(Math.round)) : null;
      chain = chain.then(async () => {
        const d = await lumaOf(f);
        f.close();
        held--;
        drawFrame(sg, i, fps, W, H, A);
        const sy = rgbaToY(sg.getImageData(0, 0, W, H).data, W, H, matrix);
        if (cropData) {
          crops[i] = crops[i] ?? {};
          crops[i][job.label] = cropData;
          crops[i].source = crops[i].source ?? sg.getImageData(...L.regions.smallText.map(Math.round));
        }
        if (i % step !== 0) return;
        const full = psnr(d.y, sy, W, [0, 0, W, H]);
        samples.push({
          frame: i, t: +(i / fps).toFixed(3),
          psnr: +full.psnr.toFixed(2), mse: full.mse,
          psnrSmallText: +psnr(d.y, sy, W, L.regions.smallText).psnr.toFixed(2),
          psnrCode: +psnr(d.y, sy, W, L.regions.code).psnr.toFixed(2),
          ssim: +ssim8(d.y, sy, W, H).toFixed(4),
          edgeSmallText: +edgeSimilarity(d.y, sy, W, L.regions.smallText).toFixed(4),
        });
      }).catch((e) => { err = e; });
    },
    error: (e) => { err = e; },
  });
  dec.configure({ codec: job.codecString, codedWidth: W, codedHeight: H });
  for (const c of chunks) {
    dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, duration: c.dur ?? undefined, data: c.data }));
    while (dec.decodeQueueSize > 8) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
    if (held > 1) await chain;
  }
  await dec.flush(); dec.close();
  await chain;
  if (err) throw err;
  samples.sort((a, b) => a.frame - b.frame);
  const seg = (lo, hi) => {
    const s = samples.filter((x) => x.t >= lo && x.t < hi);
    const avg = (k) => +(s.reduce((n, x) => n + x[k], 0) / Math.max(1, s.length)).toFixed(k === 'ssim' || k === 'edgeSmallText' ? 4 : 2);
    const mse = s.reduce((n, x) => n + x.mse, 0) / Math.max(1, s.length);
    return { frames: s.length, psnr: avg('psnr'), psnrByMse: +(10 * Math.log10((255 * 255) / mse)).toFixed(2), psnrSmallText: avg('psnrSmallText'), psnrCode: avg('psnrCode'), ssim: avg('ssim'), edgeSmallText: avg('edgeSmallText'), minPsnr: Math.min(...s.map((x) => x.psnr)) };
  };
  return { all: seg(0, 1e9), static: seg(0, 2), scroll: seg(2, 4), zoom: seg(4, 6), samples: samples.map(({ mse, ...x }) => x) };
}

/** Pure decode throughput (frames closed at once): what preview and scrubbing cost. */
async function decodeSpeed(codecString, W, H, chunks) {
  let err = null;
  const dec = new VideoDecoder({ output: (f) => f.close(), error: (e) => { err = e; } });
  dec.configure({ codec: codecString, codedWidth: W, codedHeight: H });
  const before = await metrics();
  const t0 = performance.now();
  for (const c of chunks) {
    dec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data }));
    while (dec.decodeQueueSize > 8) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
  }
  await dec.flush(); dec.close();
  const sec = (performance.now() - t0) / 1000;
  if (err) throw err;
  const cpu = cpuDelta(before, await metrics());
  return { seconds: +sec.toFixed(2), framesPerSecond: +(chunks.length / sec).toFixed(1), cpuSeconds: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +v.toFixed(2)])) };
}

async function opusTrack(seconds) {
  const chunks = [];
  let description = null;
  const ae = new AudioEncoder({
    output: (c, meta) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, ts: c.timestamp, dur: c.duration ?? 20000 }); if (meta?.decoderConfig?.description && !description) description = new Uint8Array(meta.decoderConfig.description); },
    error: () => undefined,
  });
  ae.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 });
  const n = 48000 * seconds;
  const pcm = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    const f0 = 180 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / (h * 2.2);
    v *= 0.25 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    pcm[i] = v; pcm[n + i] = v * 0.8 + 0.05 * Math.sin(2 * Math.PI * 1000 * t);
  }
  ae.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data: pcm }));
  await ae.flush(); ae.close();
  return { chunks, description };
}

async function mux(job, chunks, audio) {
  const m = memorySink();
  const lastDurMs = 1000 / job.fps;
  if (job.container === 'webm') {
    const w = new WebmWriter({ video: { codec: job.codec === 'vp8' ? 'V_VP8' : 'V_VP9', width: job.W, height: job.H }, audio: { codec: 'A_OPUS', sampleRate: 48000, channels: 2 }, sink: m.sink });
    for (const a of audio.chunks) await w.addAudio(a.data, a.ts);
    for (const c of chunks) await w.addVideo(c.data, c.ts, c.key);
    await w.finish(lastDurMs);
  } else {
    const w = new Mp4Writer({ video: { codec: job.codec === 'vp8' ? 'vp08' : 'vp09', width: job.W, height: job.H, codecString: job.codec === 'vp8' ? 'vp08.00.10.08' : job.codecString }, audio: { codec: 'opus', sampleRate: 48000, channels: 2, description: audio.description ?? undefined }, sink: m.sink });
    for (const a of audio.chunks) await w.addAudio(a.data, a.ts, a.dur);
    for (const c of chunks) await w.addVideo(c.data, c.ts, c.dur ?? 1e6 / job.fps, c.key);
    await w.finish();
  }
  return m.bytes();
}

/** Plays the written file in a <video> element: metadata, a seek and real-time frames. */
async function playback(file, W, H, seconds) {
  const v = document.createElement('video');
  v.muted = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:36px';
  document.body.appendChild(v);
  const url = `file://${file}`;
  try {
    v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error(v.error?.message ?? 'video error')); setTimeout(() => rej(new Error('timeout')), 15000); });
    const meta = { width: v.videoWidth, height: v.videoHeight, duration: +v.duration.toFixed(3) };
    v.currentTime = seconds / 2;
    await new Promise((res, rej) => { v.onseeked = res; setTimeout(() => rej(new Error('seek timeout')), 15000); });
    v.currentTime = 0;
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 5000); });
    let presented = 0;
    v.requestVideoFrameCallback(function step(_n, m) { presented = m.presentedFrames; if (!v.ended) v.requestVideoFrameCallback(step); });
    await v.play();
    await new Promise((res) => { v.onended = res; setTimeout(res, (seconds + 4) * 1000); });
    const q = v.getVideoPlaybackQuality();
    return { ok: meta.width === W && meta.height === H && Math.abs(meta.duration - seconds) < 0.25 && presented > 0, ...meta, presentedFrames: presented, droppedFrames: q.droppedVideoFrames, totalFrames: q.totalVideoFrames, audioBytesDecoded: v.webkitAudioDecodedByteCount ?? null, ended: v.ended };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally { v.remove(); }
}

async function comparisonImage(file, crops, order) {
  const items = order.filter((k) => crops[k]);
  const w = crops.source.width, h = crops.source.height;
  const pad = 28;
  const c = new OffscreenCanvas(w * 2 + 12, (h + pad) * Math.ceil(items.length / 2));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  items.forEach((k, n) => {
    const x = (n % 2) * (w + 12), y = Math.floor(n / 2) * (h + pad);
    g.fillStyle = '#000'; g.font = '600 18px -apple-system, Arial, sans-serif'; g.fillText(k, x + 4, y + 20);
    const tmp = new OffscreenCanvas(w, h); tmp.getContext('2d').putImageData(crops[k], 0, 0);
    g.drawImage(tmp, x, y + pad);
  });
  const b = await c.convertToBlob({ type: 'image/png' });
  fs.writeFileSync(file, new Uint8Array(await b.arrayBuffer()));
}

// ---------- main ----------
(async () => {
  const cfg = await ipcRenderer.invoke('config');
  const result = { tool: 'tools/codec-bench', date: new Date().toISOString(), info: await ipcRenderer.invoke('info'), seconds: cfg.seconds, support: {}, calibration: {}, configs: [] };
  try {
    fs.mkdirSync(cfg.filesDir, { recursive: true });
    // Container / playback support as the page sees it.
    for (const t of ['video/webm; codecs="vp8, opus"', 'video/webm; codecs="vp9, opus"', 'video/mp4; codecs="vp08.00.10.08, opus"', 'video/mp4; codecs="vp09.00.41.08, opus"']) {
      result.support[t] = { canPlayType: document.createElement('video').canPlayType(t), mse: MediaSource.isTypeSupported(t) };
    }
    for (const codec of ['vp8', 'vp09.00.51.08']) {
      for (const hw of ['prefer-hardware', 'prefer-software']) {
        try { result.support[`decode ${codec} 3840x2160 ${hw}`] = (await VideoDecoder.isConfigSupported({ codec, codedWidth: 3840, codedHeight: 2160, hardwareAcceleration: hw })).supported; } catch (e) { result.support[`decode ${codec} ${hw}`] = String(e); }
      }
    }
    for (const codec of ['vp8', 'vp9']) { result.calibration[codec] = await calibrate(codec); log(`calibration ${codec}: ${JSON.stringify(result.calibration[codec])}`); }
    const audio = await opusTrack(cfg.seconds);
    for (const target of cfg.targets) {
      const { W, H, fps, bitrate } = target;
      const frames = cfg.seconds * fps;
      const A = makeAssets(W, H);
      const name = `${H >= 2000 ? '4K' : `${H}p`}${fps}`;
      const entry = { name, width: W, height: H, fps, frames, appBitrate: bitrate, generationOnly: null, runs: [] };
      log(`== ${name}`);
      // Baseline: drawing + VideoFrame creation only (no encoder).
      {
        const before = await metrics(); const stop = sampler(); const t0 = performance.now();
        await encodeAll(null, frames, fps, W, H, A);
        const sec = (performance.now() - t0) / 1000;
        entry.generationOnly = { seconds: +sec.toFixed(2), cpuSeconds: cpuDelta(before, await metrics()), sampled: await stop() };
      }
      const cropAt = [Math.round(1.5 * fps), Math.round(5 * fps)];
      const crops = {};
      for (const run of cfg.runs) {
        const rate = Math.round(bitrate * run.factor);
        const label = `${run.codec.toUpperCase()} ${(rate / 1e6).toFixed(1)} Mb/s`;
        const { config, accel, support } = await pickConfig(run.codec, W, H, fps, rate);
        const rec = { label, codec: run.codec, factor: run.factor, bitrate: rate, accel, encoderSupport: support };
        if (!config) { rec.error = 'kodlayıcı desteklenmiyor'; entry.runs.push(rec); continue; }
        // Timed twice; the faster pass is reported (the first may include warm-up).
        const passes = [];
        let chunks = null;
        for (let p = 0; p < cfg.repeat; p++) {
          const before = await metrics(); const stop = sampler(); const t0 = performance.now();
          const got = await encodeAll(config, frames, fps, W, H, A);
          const sec = (performance.now() - t0) / 1000;
          passes.push({ sec, cpu: cpuDelta(before, await metrics()), sampled: await stop() });
          chunks = chunks ?? got;
        }
        passes.sort((a, b) => a.sec - b.sec);
        const { sec, cpu, sampled } = passes[0];
        const bytes = chunks.reduce((n, c) => n + c.data.length, 0);
        Object.assign(rec, {
          codecString: config.codec, wallSeconds: +sec.toFixed(2), wallSecondsAllPasses: passes.map((x) => +x.sec.toFixed(2)), framesPerSecond: +(frames / sec).toFixed(1), realtimeFactor: +((frames / fps) / sec).toFixed(2),
          cpuSeconds: Object.fromEntries(Object.entries(cpu).map(([k, v]) => [k, +v.toFixed(2)])), cpu: sampled,
          videoBytes: bytes, actualVideoMbps: +((bytes * 8) / (frames / fps) / 1e6).toFixed(2), keyFrames: chunks.filter((c) => c.key).length,
        });
        log(`${name} ${label}: ${rec.wallSeconds}s (${rec.framesPerSecond} fps, ${accel}), ${rec.actualVideoMbps} Mb/s`);
        const job = { ...run, W, H, fps, frames, codecString: config.codec, label };
        rec.decode = await decodeSpeed(config.codec, W, H, chunks);
        rec.quality = await measure(job, chunks, result.calibration[run.codec].matrix, A, cropAt, crops);
        log(`  PSNR ${rec.quality.all.psnr} dB, SSIM ${rec.quality.all.ssim}, small text ${rec.quality.all.psnrSmallText} dB, edges ${rec.quality.all.edgeSmallText}`);
        rec.files = [];
        for (const container of run.containers) {
          const bytesOut = await mux({ ...job, container }, chunks, audio);
          const file = path.join(cfg.filesDir, `${name}-${run.codec}-${(rate / 1e6).toFixed(1)}mbps.${container}`);
          fs.writeFileSync(file, bytesOut);
          const play = await playback(file, W, H, cfg.seconds);
          rec.files.push({ file: path.relative(cfg.root, file), container, bytes: bytesOut.length, playback: play });
          log(`  ${container}: ${(bytesOut.length / 1e6).toFixed(1)} MB, playback ${play.ok ? 'ok' : `FAIL ${play.error ?? ''}`}`);
        }
        entry.runs.push(rec);
      }
      entry.crops = [];
      for (const i of cropAt) {
        if (!crops[i]) continue;
        const file = path.join(cfg.filesDir, `${name}-kucuk-yazi-${(i / fps).toFixed(1)}s.png`);
        await comparisonImage(file, crops[i], ['source', ...cfg.runs.map((r) => `${r.codec.toUpperCase()} ${((bitrate * r.factor) / 1e6).toFixed(1)} Mb/s`)]);
        entry.crops.push(path.relative(cfg.root, file));
      }
      result.configs.push(entry);
    }
  } catch (e) {
    result.error = String(e?.stack ?? e);
    log(result.error);
  }
  ipcRenderer.send('done', result);
})();
