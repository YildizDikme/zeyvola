/**
 * Shared pieces of the in-app test suites (smoke, perftest, uitest, docshots): waiting helpers,
 * the sample project and access to the open editor. Everything here works on a temporary
 * projects folder with made-up content; no real screen, camera or person is involved.
 */
import type { CpuSample } from '@zeyvola/protocol';
import { secondsToTicks } from '@zeyvola/timing';
import { api } from '../api';
import type { Player } from '../playback/player';
import type { EditorStore } from '../state/editor-store';
import { synthesizeRecording, type SyntheticRecording } from '../smoke-fixtures';

export interface Check { name: string; ok: boolean; detail?: string; ms?: number }

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const frame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));

/** Polls `fn` until it returns something truthy; null after `ms`. */
export async function until<T>(fn: () => T | null | undefined | false, ms = 10_000, every = 100): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

export interface OpenEditor { store: EditorStore; player: Player }
type TestWindow = Window & { __zeyvolaEditor?: OpenEditor };

/** The editor currently on screen (Editor.tsx publishes it in test mode only). */
export function currentEditor(projectId?: string): OpenEditor | null {
  const e = (window as TestWindow).__zeyvolaEditor;
  return e && (!projectId || e.store.project.id === projectId) ? e : null;
}

export const invoke = <T>(channel: string, payload?: unknown): Promise<T> => window.zeyvola.invoke(channel, payload) as Promise<T>;

/** Saves a picture of the window as <name>.png in the run's screenshot folder. */
export async function screenshot(name: string, settleMs = 700): Promise<string | null> {
  await sleep(settleMs);
  const r = await invoke<{ file: string } | null>('smoke:shot', name);
  return r?.file ?? null;
}

export const cpuNow = (): Promise<CpuSample> => invoke<CpuSample>('smoke:cpu');

/** Average CPU use between two samples, in percent of one core (100 = one core busy). */
export function cpuPercent(a: CpuSample, b: CpuSample): number {
  const wall = (b.atMs - a.atMs) / 1000;
  return wall > 0 ? ((b.seconds - a.seconds) / wall) * 100 : 0;
}

export interface SampleProject {
  id: string;
  recordingId: string;
  /** Project-relative path of the screen video. */
  screenFile: string;
  /** The generated files; null for a recording brought in from outside. */
  recording: SyntheticRecording | null;
}

export const SAMPLE_PROJECT_NAME = 'Hesap ayarları turu';

/**
 * Creates the sample project: a made-up settings screen ("Örnek Uygulama", "Deniz Örnek"),
 * an abstract camera picture, a tone as the voice and a scripted pointer with four clicks.
 * `make` swaps the recording (the perf test also uses a browser-style recording).
 */
export async function createSampleProject(seconds = 8, name = SAMPLE_PROJECT_NAME, make: (s: number) => Promise<SyntheticRecording> = synthesizeRecording): Promise<SampleProject> {
  const rec = await make(seconds);
  const { id } = await api.createProject(name);
  const recordingId = `rec_${crypto.randomUUID()}`;
  const dir = `media/${recordingId}`;
  const ext = rec.videoMime === 'video/webm' ? 'webm' : 'mp4';
  const micName = rec.micMime === 'audio/webm' ? 'mic.weba' : 'mic.m4a';
  const files: [string, Uint8Array][] = [[`screen.${ext}`, rec.screen], [`camera.${ext}`, rec.camera], [micName, rec.mic], ['cursor.jsonl', new TextEncoder().encode(rec.cursorLog)]];
  for (const [file, data] of files) await invoke('smoke:writeFile', { projectId: id, path: `${dir}/${file}`, data });
  const dur = secondsToTicks(rec.durationMs / 1000);
  await invoke('smoke:appendRecording', {
    projectId: id,
    recording: {
      id: recordingId, createdAt: new Date().toISOString(), duration: dur,
      sources: {
        screen: { kind: 'screen', file: `${dir}/screen.${ext}`, mime: rec.videoMime, width: rec.screenSize.width, height: rec.screenSize.height, fps: rec.screenFps ?? 30, startOffset: 0, duration: dur },
        camera: { kind: 'camera', file: `${dir}/camera.${ext}`, mime: rec.videoMime, width: rec.cameraSize.width, height: rec.cameraSize.height, fps: 30, startOffset: 0, duration: dur },
        mic: { kind: 'mic', file: `${dir}/${micName}`, mime: rec.micMime ?? 'audio/mp4', sampleRate: 48000, channels: 1, startOffset: 0, duration: dur },
      },
      cursorFile: `${dir}/cursor.jsonl`,
      capture: {
        backend: rec.backend ?? 'native-macos', platform: 'smoke',
        target: { kind: 'display', label: 'Sentetik', bounds: { x: 0, y: 0, w: rec.screenSize.width, h: rec.screenSize.height }, scaleFactor: 1 },
        cursorInFrames: rec.backend === 'web', hasClicks: true,
      },
      syncOffsets: {}, markers: [],
    },
  });
  return { id, recordingId, screenFile: `${dir}/screen.${ext}`, recording: rec };
}

/** Opens a project in the editor the way the Home screen does and waits until it is there. */
export async function openInEditor(projectId: string): Promise<OpenEditor | null> {
  window.dispatchEvent(new CustomEvent('zeyvola:smoke-open', { detail: projectId }));
  return until(() => currentEditor(projectId));
}

/** Basic statistics of a list of numbers (milliseconds, usually). */
export function stats(values: readonly number[]): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { n: s.length, mean: r(s.reduce((a, b) => a + b, 0) / s.length), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]!) };
}

// ─── Driving the interface ────────────────────────────────────────────────────
// Elements are found by what a person sees (visible text, accessible name) and clicked with the
// events a mouse sends. Used by the interface test and the README screenshots.

export const q = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T | null => root.querySelector<T>(selector);
export const all = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(selector)];
export const text = (el: Element | null | undefined): string => (el?.textContent ?? '').trim();

/** A button by its visible text or accessible name; only enabled, visible ones count. */
export function button(name: string, root: ParentNode = document): HTMLButtonElement | null {
  return all<HTMLButtonElement>('button', root).find((b) => !b.disabled && b.offsetParent !== null && (text(b) === name || b.getAttribute('aria-label') === name)) ?? null;
}

/** An option of a segmented control (role=radio) by the group's name and the option's text. */
export function option(group: string, name: string, root: ParentNode = document): HTMLButtonElement | null {
  const g = all('[role="radiogroup"]', root).find((x) => x.getAttribute('aria-label') === group);
  return g ? all<HTMLButtonElement>('[role="radio"]', g).find((b) => text(b) === name) ?? null : null;
}

/** An element the test expected on screen is not there. */
export class Missing extends Error {}

/** Clicks like a mouse does: pointer and mouse events on the element's centre, then the click. */
export function click(el: HTMLElement | null, what: string): void {
  if (!el) throw new Missing(`bulunamadı: ${what}`);
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1, pointerId: 1, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 1, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', at));
  el.click();
}

/** Presses and releases at a point inside an element (fractions of its size). */
export function pressAt(el: HTMLElement | null, fx: number, fy: number, what: string): void {
  if (!el) throw new Missing(`bulunamadı: ${what}`);
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', at));
}

export const key = (k: string, init: KeyboardEventInit = {}): void => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); };

// ─── Checking written files ───────────────────────────────────────────────────

/** Project-relative path → URL of the media protocol. */
export const mediaUrl = (mediaBase: string, rel: string): string => mediaBase + rel.split('/').map(encodeURIComponent).join('/');

export interface VideoProbe { ok: boolean; duration: number; width: number; height: number; /** Spread of the picture's brightness at `at` (0 = one flat colour). */ spread: number }

/**
 * Opens a video through the media protocol: what the player reports, and how much the picture
 * varies at `at` seconds (a blank or one-colour frame has a spread near 0).
 */
export async function probeVideo(url: string, at?: number): Promise<VideoProbe> {
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous';
  v.src = url;
  const ok = await new Promise<boolean>((res) => { v.onloadedmetadata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(false), 8000); });
  let spread = Number.NaN;
  if (ok && at !== undefined) {
    v.currentTime = Math.min(at, Math.max(0, v.duration - 0.1));
    const seeked = await new Promise<boolean>((res) => { v.onseeked = () => res(true); setTimeout(() => res(false), 5000); });
    if (seeked && v.readyState >= 2) {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 36;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      const luma: number[] = [];
      for (let i = 0; i < d.length; i += 4) luma.push((d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114) / 255);
      const mean = luma.reduce((a, b) => a + b, 0) / luma.length;
      spread = Math.sqrt(luma.reduce((a, b) => a + (b - mean) ** 2, 0) / luma.length);
    }
  }
  const out = { ok, duration: v.duration, width: v.videoWidth, height: v.videoHeight, spread };
  v.removeAttribute('src');
  v.load();
  return out;
}

/** Decodes the sound of a file (any container Chromium reads); rejects when it has none. */
export async function decodeSound(url: string): Promise<AudioBuffer> {
  const data = await fetch(url).then((r) => r.arrayBuffer());
  return new OfflineAudioContext(1, 1, 48_000).decodeAudioData(data);
}

/** Loudest sample of a decoded sound (0…1). */
export function peak(buf: AudioBuffer): number {
  let max = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) for (const s of buf.getChannelData(ch)) max = Math.max(max, Math.abs(s));
  return max;
}
