import { addRecording, type Recording } from '@zeyvola/project-model';
import type { ImportedVideo, PickedFile } from '@zeyvola/protocol';
import { secondsToTicks } from '@zeyvola/timing';
import { api } from '../../api';
import type { EditorStore } from '../../state/editor-store';
import { t } from '../../i18n';

interface VideoInfo { duration: number; width: number; height: number; hasAudio: boolean }

/** Reads length, size and whether there is sound, using the browser's own decoder. */
export async function probeVideo(url: string): Promise<VideoInfo | null> {
  const v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.crossOrigin = 'anonymous';
  const loaded = await new Promise<boolean>((res) => {
    v.onloadedmetadata = () => res(true);
    v.onerror = () => res(false);
    setTimeout(() => res(false), 15_000);
    v.src = url;
  });
  if (!loaded || !v.videoWidth) { v.removeAttribute('src'); v.load(); return null; }
  // Metadata alone does not prove the picture can be shown: without a decoder for its codec (for
  // example H.264 or HEVC on a system without one) no frame ever arrives. Wait for the first frame.
  const decoded = v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || await new Promise<boolean>((res) => {
    v.onloadeddata = () => res(true);
    v.onerror = () => res(false);
    setTimeout(() => res(v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA), 15_000);
  });
  if (!decoded) { v.removeAttribute('src'); v.load(); return null; }
  let duration = v.duration;
  if (!Number.isFinite(duration)) {
    // Some WebM files only learn their length after a seek to the end.
    duration = await new Promise<number>((res) => {
      v.ondurationchange = () => { if (Number.isFinite(v.duration)) res(v.duration); };
      setTimeout(() => res(Number.isFinite(v.duration) ? v.duration : 0), 5_000);
      v.currentTime = 1e9;
    });
  }
  let hasAudio = true; // when unsure, keep the sound: a silent track does no harm
  try {
    const stream = (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
    if (stream) {
      await new Promise((r) => setTimeout(r, 120));
      hasAudio = stream.getAudioTracks().length > 0;
      for (const tr of stream.getTracks()) tr.stop();
    }
  } catch { /* keep the default */ }
  const info = { duration, width: v.videoWidth, height: v.videoHeight, hasAudio };
  v.removeAttribute('src');
  v.load();
  return duration > 0.05 ? info : null;
}

/** The recording entry for a video added from the computer: its picture and its own sound. */
export function importedRecording(imp: ImportedVideo, info: VideoInfo): Recording {
  const duration = secondsToTicks(info.duration);
  return {
    id: imp.recordingId,
    createdAt: new Date().toISOString(),
    duration,
    sources: {
      screen: { kind: 'screen', file: imp.file, mime: imp.mime, width: info.width, height: info.height, startOffset: 0, duration },
      // The video's sound plays on the system-audio track, so it has its own level and mute.
      // AAC sound the app cannot decode arrives re-encoded by the operating system (imp.audio).
      // Sound that could not be converted (imp.audioIssue) is left out rather than added silent.
      ...(imp.audio
        ? { system: { kind: 'system' as const, file: imp.audio.file, mime: imp.audio.mime, startOffset: 0, duration } }
        : info.hasAudio && !imp.audioIssue ? { system: { kind: 'system' as const, file: imp.file, mime: imp.mime, startOffset: 0, duration } } : {}),
    },
    capture: {
      backend: 'import', platform: 'file',
      target: { kind: 'display', label: imp.name, bounds: { x: 0, y: 0, w: info.width, h: info.height }, scaleFactor: 1 },
      cursorInFrames: true, hasClicks: false,
    },
    syncOffsets: {},
    markers: [],
  };
}

/**
 * Adds a video from the computer to the end of the timeline. `pick` defaults to the system
 * file dialog (the smoke test passes a stand-in).
 */
export async function importVideo(store: EditorStore, pick: () => Promise<PickedFile | null> = api.pickVideo): Promise<boolean> {
  const projectId = store.project.id;
  let picked: PickedFile | null;
  try {
    picked = await pick();
  } catch (e) {
    store.notify((e as Error).message);
    return false;
  }
  if (!picked) return false;
  store.notify(t("Video ekleniyor: {name}…", { name: picked.name }));
  let imp: ImportedVideo;
  try {
    imp = await api.importVideo(projectId, picked.token);
  } catch (e) {
    store.notify((e as Error).message);
    return false;
  }
  const url = store.getState().mediaBase + imp.file.split('/').map(encodeURIComponent).join('/');
  const info = await probeVideo(url);
  if (!info) {
    await api.discardImport(projectId, imp.recordingId).catch(() => undefined);
    store.notify(t("Bu video açılamadı. MP4, MOV veya WebM biçiminde bir video deneyin."));
    return false;
  }
  const rec = importedRecording(imp, info);
  store.apply((p) => addRecording(p, rec));
  const seg = store.project.sequence.segments.find((s) => s.recordingId === rec.id);
  if (seg) store.select({ kind: 'segment', id: seg.id });
  if (imp.audioIssue) {
    // Never lose sound silently: say so, and for long enough to be read.
    const codec = imp.audioIssue.codec;
    store.notify(imp.audioIssue.reason === 'helper-missing'
      ? t("Video eklendi ama sesi denetlenemedi; ses yardımcısı bulunamadı. Video sessiz eklendi.")
      : t("Video eklendi ama sesi açılamadı ({codec}). Video sessiz eklendi.", { codec: codec.toUpperCase() }), 8000);
  } else store.notify(t("Video eklendi: {name}", { name: imp.name }));
  return true;
}
