// Codec probe: measures which encoders, decoders and containers the running Electron
// build really offers. Used to verify distribution packages (tools/codec-audit.mjs), so it
// runs inside the packaged app, against that package's own Chromium and libffmpeg.
//
//   <app> --codec-probe <out.json> [--codec-fixtures <dir>]
//
// The fixtures folder may hold files made by the operating system's encoders (for example
// tests/real-capture/make-fixture.swift → fixture.mp4 H.264, fixture.m4a AAC); each one is
// loaded in a <video>/<audio> element and, for audio, through decodeAudioData.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow } from 'electron';
import { DIST, PROFILE } from '../shared/distribution';

interface Fixture { name: string; url: string; kind: 'video' | 'audio'; base64?: string }

/** Runs in the page. Plain JavaScript only: it is serialized with toString(). */
async function pageProbe(fixtures: Fixture[], recorderMime: string): Promise<unknown> {
  const tryBool = async (f: () => Promise<{ supported?: boolean }>): Promise<boolean | string> => {
    try { return !!(await f()).supported; } catch (e) { return `hata: ${(e as Error).name}`; }
  };
  const video: Record<string, unknown> = {};
  const vcodecs: Record<string, string> = { h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', vp8: 'vp8', vp9: 'vp09.00.41.08', av1: 'av01.0.08M.08' };
  // Software H.264/HEVC encoders are never asked for, not even here: in Electron that would
  // start OpenH264, which no Zeyvola code path may do. Its presence is checked in the binary.
  const skip = (codec: string, hw: string) => hw === 'prefer-software' && (codec.startsWith('avc1') || codec.startsWith('hvc1'));
  for (const [name, codec] of Object.entries(vcodecs)) {
    const row: Record<string, unknown> = {};
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      row[`encode:${hw}`] = skip(codec, hw) ? 'sorulmadı' : await tryBool(() => VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4e6, framerate: 30, hardwareAcceleration: hw }));
      row[`decode:${hw}`] = await tryBool(() => VideoDecoder.isConfigSupported({ codec, codedWidth: 1280, codedHeight: 720, hardwareAcceleration: hw }));
    }
    video[name] = row;
  }
  // Real encodes: a few frames per supported configuration.
  const encodeRuns: Record<string, unknown> = {};
  const canvas = new OffscreenCanvas(640, 360);
  const g = canvas.getContext('2d')!;
  for (const [name, codec] of Object.entries(vcodecs)) {
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      if (skip(codec, hw)) continue;
      const cfg: VideoEncoderConfig = { codec, width: 640, height: 360, bitrate: 1e6, framerate: 30, hardwareAcceleration: hw, ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) };
      const supported = await tryBool(() => VideoEncoder.isConfigSupported(cfg));
      if (supported !== true) continue;
      let bytes = 0; let desc: Uint8Array | null = null; let err: string | null = null;
      const chunks: EncodedVideoChunk[] = [];
      const enc = new VideoEncoder({
        output: (c, meta) => { chunks.push(c); bytes += c.byteLength; if (meta?.decoderConfig?.description && !desc) desc = new Uint8Array(meta.decoderConfig.description as ArrayBuffer); },
        error: (e) => { err = e.message; },
      });
      try {
        enc.configure(cfg);
        for (let i = 0; i < 10; i++) {
          g.fillStyle = `hsl(${i * 30} 70% 50%)`; g.fillRect(0, 0, 640, 360);
          const f = new VideoFrame(canvas, { timestamp: i * 33_333 });
          enc.encode(f, { keyFrame: i === 0 });
          f.close();
        }
        await enc.flush();
      } catch (e) { err = (e as Error).message; }
      try { enc.close(); } catch { /* closed */ }
      const d = desc as Uint8Array | null;
      // Decode what was just encoded: isConfigSupported alone does not prove a decoder exists.
      const decoded: Record<string, unknown> = {};
      for (const dhw of ['prefer-hardware', 'prefer-software'] as const) {
        let frames = 0; let derr: string | null = null;
        const dec = new VideoDecoder({ output: (f) => { frames++; f.close(); }, error: (e) => { derr = e.message; } });
        try {
          dec.configure({ codec, codedWidth: 640, codedHeight: 360, hardwareAcceleration: dhw, ...(d ? { description: d } : {}) });
          for (const c of chunks) dec.decode(c);
          await dec.flush();
        } catch (e) { derr = derr ?? (e as Error).message; }
        try { dec.close(); } catch { /* closed */ }
        decoded[dhw] = derr ? `hata: ${derr}` : frames;
      }
      encodeRuns[`${name}:${hw}`] = { chunks: chunks.length, bytes, error: err, decodedFrames: decoded, ...(name === 'h264' && d && d.length > 3 ? { avcProfileIdc: d[1], avcLevelIdc: d[3] } : {}) };
    }
  }
  const audio: Record<string, unknown> = {};
  const acodecs: Record<string, string> = { aac: 'mp4a.40.2', opus: 'opus', mp3: 'mp3', flac: 'flac', vorbis: 'vorbis', pcm: 'pcm-s16' };
  for (const [name, codec] of Object.entries(acodecs)) {
    audio[name] = {
      encode: await tryBool(() => AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })),
      decode: await tryBool(() => AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 })),
    };
  }
  for (const name of ['aac', 'opus']) {
    const codec = acodecs[name]!;
    if ((audio[name] as { encode: unknown }).encode !== true) continue;
    let err: string | null = null; let desc: ArrayBuffer | null = null;
    const chunks: EncodedAudioChunk[] = [];
    const enc = new AudioEncoder({ output: (c, meta) => { chunks.push(c); if (meta?.decoderConfig?.description && !desc) desc = meta.decoderConfig.description as ArrayBuffer; }, error: (e) => { err = e.message; } });
    try {
      enc.configure({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      const n = 48000;
      const pcm = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) pcm[i] = pcm[n + i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.3;
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data: pcm }));
      await enc.flush();
    } catch (e) { err = (e as Error).message; }
    try { enc.close(); } catch { /* closed */ }
    let samples = 0; let derr: string | null = null;
    const dec = new AudioDecoder({ output: (a) => { samples += a.numberOfFrames; a.close(); }, error: (e) => { derr = e.message; } });
    try {
      dec.configure({ codec, sampleRate: 48000, numberOfChannels: 2, ...(desc ? { description: desc } : {}) });
      for (const c of chunks) dec.decode(c);
      await dec.flush();
    } catch (e) { derr = derr ?? (e as Error).message; }
    try { dec.close(); } catch { /* closed */ }
    encodeRuns[`${name}:audio`] = { chunks: chunks.length, error: err, decodedSamples: derr ? `hata: ${derr}` : samples };
  }
  const types = [
    'video/mp4; codecs="avc1.640028, mp4a.40.2"', 'video/mp4; codecs="avc1.640028"', 'audio/mp4; codecs="mp4a.40.2"',
    'video/mp4; codecs="vp09.00.41.08, opus"', 'video/mp4; codecs="av01.0.08M.08, opus"', 'audio/mp4; codecs="opus"',
    'video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="av01.0.08M.08, opus"',
    'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg; codecs="opus"',
  ];
  const v = document.createElement('video');
  const canPlay: Record<string, string> = {};
  const mse: Record<string, boolean> = {};
  for (const t of types) { canPlay[t] = v.canPlayType(t); mse[t] = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t); }
  const recorder: Record<string, boolean> = {};
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=av1,opus', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=vp9,opus', 'video/mp4', 'video/x-matroska;codecs=avc1']) {
    recorder[t] = MediaRecorder.isTypeSupported(t);
  }
  // Playback of real files (fixtures) and of a WebM made here by MediaRecorder.
  const play = (src: string, kind: 'video' | 'audio') => new Promise<Record<string, unknown>>((resolve) => {
    const el = document.createElement(kind);
    el.muted = true;
    const timer = setTimeout(() => resolve({ ok: false, error: 'zaman aşımı' }), 8000);
    el.addEventListener('loadeddata', () => {
      clearTimeout(timer);
      resolve({ ok: true, duration: Number(el.duration.toFixed(3)), ...(kind === 'video' ? { width: (el as HTMLVideoElement).videoWidth, height: (el as HTMLVideoElement).videoHeight } : {}) });
    }, { once: true });
    el.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, error: `MediaError ${el.error?.code}: ${el.error?.message ?? ''}` }); }, { once: true });
    el.src = src;
  });
  const files: Record<string, unknown> = {};
  for (const f of fixtures) {
    const row: Record<string, unknown> = { element: await play(f.url, f.kind) };
    if (f.base64) {
      try {
        const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        const buf = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bin.buffer);
        row.decodeAudioData = { ok: true, duration: Number(buf.duration.toFixed(3)), channels: buf.numberOfChannels };
      } catch (e) { row.decodeAudioData = { ok: false, error: (e as Error).message }; }
    }
    files[f.name] = row;
  }
  try {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 180;
    const cg = c.getContext('2d')!;
    const stream = c.captureStream(30);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]!);
    const rec = new MediaRecorder(stream, { mimeType: recorderMime });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    while (performance.now() - t0 < 1200) { cg.fillStyle = `hsl(${(performance.now() / 5) % 360} 60% 50%)`; cg.fillRect(0, 0, 320, 180); await new Promise((r) => setTimeout(r, 33)); }
    rec.stop(); await stopped; osc.stop(); await ac.close();
    files['mediarecorder.webm'] = { element: await play(URL.createObjectURL(new Blob(parts, { type: 'video/webm' })), 'video') };
  } catch (e) { files['mediarecorder.webm'] = { error: (e as Error).message }; }
  return { userAgent: navigator.userAgent, video, audio, encodeRuns, canPlay, mse, recorder, recorderMime, files };
}

export async function runCodecProbe(outPath: string, fixturesDir: string | null): Promise<number> {
  const work = await mkdtemp(join(tmpdir(), 'zeyvola-codec-probe-'));
  try {
    const fixtures: Fixture[] = [];
    if (fixturesDir) {
      for (const name of (await readdir(fixturesDir)).sort()) {
        const ext = extname(name).toLowerCase();
        const kind = ['.mp4', '.mov', '.webm', '.mkv'].includes(ext) ? 'video' : ['.m4a', '.wav', '.mp3', '.ogg', '.opus', '.flac', '.aac'].includes(ext) ? 'audio' : null;
        if (!kind) continue;
        const path = join(fixturesDir, name);
        fixtures.push({ name, kind, url: pathToFileURL(path).href, ...(kind === 'audio' ? { base64: (await readFile(path)).toString('base64') } : {}) });
      }
    }
    const page = join(work, 'probe.html');
    await writeFile(page, '<!doctype html><meta charset="utf-8"><title>codec probe</title>');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await win.loadFile(page);
    // The distribution's first Chromium recording format, with Opus (as capture.ts records).
    const recorderMime = `${PROFILE.recorderVideo[0]},opus`;
    const result = await win.webContents.executeJavaScript(`(${pageProbe.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(recorderMime)})`, true);
    const report = {
      distribution: DIST, electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch,
      execPath: process.execPath, fixtures: fixtures.map((f) => f.name), ...result as object,
    };
    // Written before the window closes: on Windows and Linux the last window closing quits the app.
    await writeFile(outPath, `${JSON.stringify(report, null, 1)}\n`);
    win.destroy();
    return 0;
  } catch (e) {
    process.stderr.write(`Codec sondası başarısız: ${(e as Error).stack ?? String(e)}\n`);
    return 1;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
