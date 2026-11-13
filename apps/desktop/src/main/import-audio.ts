// Sound of a video added from the computer. The app ships Electron's libffmpeg without proprietary
// codecs, so an MP4/MOV with AAC sound (most phone and camera videos) would play silently. The
// operating system decodes that sound instead, through a small helper next to the app:
//   macOS:   zeyvola-audio --extract-audio <video> <sound.m4a>   (AVFoundation → Opus, or PCM)
//   Windows: zeyvola-win.exe --extract-audio <video> <sound.wav> (Media Foundation → 16-bit PCM WAV)
// When the sound exists but cannot be converted, the caller is told, so the user sees a warning
// instead of silently losing the sound.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';

export interface ExtractedAudio { file: string; mime: string; from: string }
export interface AudioIssue { codec: string; reason: string }
export type ImportAudio = { audio: ExtractedAudio } | { issue: AudioIssue } | null;

/** Parses the helper's one-line answer to `--extract-audio`. */
export function parseExtractAnswer(stdout: string): { audio: boolean; converted: boolean; codec?: string; from?: string; error?: string } {
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const j = JSON.parse(line) as { type?: string; audio?: boolean; converted?: boolean; codec?: string; from?: string; error?: string };
  if (j.type !== 'audio') throw new Error('Beklenmeyen yanıt');
  return { audio: !!j.audio, converted: !!j.converted, codec: j.codec, from: j.from, error: j.error };
}

/** What to do with the answer: use the converted file, report a problem, or nothing to do. */
export function importAudioResult(answer: ReturnType<typeof parseExtractAnswer>, file: string, mime: string): ImportAudio {
  if (!answer.audio) return null; // no sound track
  if (answer.converted && !answer.error) return { audio: { file, mime, from: answer.from ?? answer.codec ?? '' } };
  if (!answer.error) return null; // a format the app plays itself (Opus, MP3, FLAC, PCM)
  return { issue: { codec: answer.from ?? answer.codec ?? 'unknown', reason: answer.error } };
}

/** Containers whose sound is usually AAC, which the app's media library cannot decode on its own. */
const AAC_CONTAINERS = /\.(mp4|m4v|mov|3gp)$/i;

/**
 * Without the helper the sound of an MP4/MOV cannot be checked or converted. Report that instead of
 * adding the video as if its sound were fine (it would play silent). WebM sound (Opus, Vorbis) plays as is.
 */
export function missingHelperResult(videoName: string): ImportAudio {
  return AAC_CONTAINERS.test(videoName) ? { issue: { codec: 'unknown', reason: 'helper-missing' } } : null;
}

function helper(): { path: string; out: string; mime: string } | null {
  const bin = (name: string, dev: string) => (app.isPackaged ? join(process.resourcesPath, 'bin', name) : resolve(app.getAppPath(), '..', '..', 'native', dev, 'bin', name));
  if (process.platform === 'darwin') return { path: bin('zeyvola-audio', 'audio-macos'), out: 'sound.m4a', mime: 'audio/mp4' };
  if (process.platform === 'win32') return { path: bin('zeyvola-win.exe', 'helper-windows'), out: 'sound.wav', mime: 'audio/wav' };
  return null;
}

/**
 * `videoAbs` is the copied video inside the project; `videoRel` the same path relative to the
 * project. Returns the converted sound file (relative), a problem to show, or null.
 */
export async function extractImportAudio(videoAbs: string, videoRel: string): Promise<ImportAudio> {
  const h = helper();
  if (!h) return null;
  if (!existsSync(h.path)) return missingHelperResult(videoAbs);
  const outAbs = join(dirname(videoAbs), h.out);
  const stdout = await new Promise<string>((res) => {
    execFile(h.path, ['--extract-audio', videoAbs, outAbs], { timeout: 10 * 60_000, maxBuffer: 1 << 20, windowsHide: true }, (_err, out) => res(String(out ?? '')));
  });
  try {
    return importAudioResult(parseExtractAnswer(stdout), join(dirname(videoRel), h.out).split('\\').join('/'), h.mime);
  } catch {
    return { issue: { codec: 'unknown', reason: 'helper' } };
  }
}
