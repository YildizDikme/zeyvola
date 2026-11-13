/**
 * Distribution profiles. One build ships one profile, fixed at build time:
 *
 *   ZEYVOLA_DIST=mp4   (default) A · the published build since 2026-11-13. Exports MP4 (H.264 + AAC)
 *                    and WebM (VP9 + Opus); records with the macOS recorder (ScreenCaptureKit, H.264
 *                    through VideoToolbox) when it is present, otherwise through Chromium (WebM).
 *                    H.264 and AAC come only from the operating system's own encoders (macOS
 *                    VideoToolbox / AudioToolbox, Windows Media Foundation); the software H.264
 *                    encoder bundled in Electron is never asked for. docs/denetim/2026-11-13-mp4-h264-karari.md.
 *   ZEYVOLA_DIST=webm  B · A's exports without the macOS recorder: records through Chromium only.
 *                    (Published until 2026-11-13; its "MP4" then held VP9 + Opus, which QuickTime
 *                    and Windows' own player open as sound only.)
 *   ZEYVOLA_DIST=webm-vp8  Experimental · records and exports VP8 + Opus in WebM only. No H.264,
 *                    AAC or HEVC in our code at all. Measured with tools/codec-bench.
 *
 * The bundlers replace __ZEYVOLA_DIST__ with a string literal, so the code for codecs a profile
 * does not ship is removed from the bundle, not just hidden (tools/codec-audit.mjs checks this).
 * Both profiles ship Electron's libffmpeg without proprietary codecs: no FFmpeg H.264 or AAC
 * decoder is distributed.
 */
declare const __ZEYVOLA_DIST__: string | undefined;

export type DistributionId = 'mp4' | 'webm' | 'webm-vp8';
export type ExportFormat = 'mp4' | 'webm';
type Accel = 'prefer-hardware' | 'no-preference';

export interface VideoChoice {
  /** WebCodecs codec family; the exact string depends on size and frame rate. */
  codec: 'avc1' | 'vp09' | 'vp8';
  /** Encoder preferences tried in order. H.264 is hardware only: Electron's software H.264 encoder is OpenH264. */
  accel: readonly Accel[];
  /** Bitrate relative to the H.264 target (exporter.ts bitrateFor). */
  bitrateScale: number;
}

export interface ExportPlan {
  container: 'mp4' | 'webm';
  video: readonly VideoChoice[];
  /** WebCodecs audio codecs tried in order. */
  audio: readonly ('mp4a.40.2' | 'opus')[];
}

export interface DistributionProfile {
  id: DistributionId;
  /** H.264 / AAC (patent-pool codecs) through operating-system encoders; must match PATENT_POOL_CODECS. */
  patentPoolCodecs: boolean;
  exports: Readonly<Partial<Record<ExportFormat, ExportPlan>>>;
  /** Formats offered, in the export dialog's order; the first is the default. */
  formats: readonly ExportFormat[];
  /** Format the export dialog opens with. */
  defaultExport: ExportFormat;
  /** MediaRecorder types for the Chromium recording path, in order. Royalty-free only in both profiles. */
  recorderVideo: readonly string[];
  recorderAudio: readonly string[];
  /** The macOS recording helper ships (it encodes H.264 with VideoToolbox). */
  nativeRecorder: boolean;
}

const VP8_BITRATE_SCALE = 1.7;
// VP9 at 0.85× the H.264 bitrate. VP8 needs about twice VP9's target for the same quality on
// screen content (tools/codec-bench).
const VP9: VideoChoice = { codec: 'vp09', accel: ['prefer-hardware', 'no-preference'], bitrateScale: 0.85 };
const VP8_FALLBACK: VideoChoice = { codec: 'vp8', accel: ['prefer-hardware', 'no-preference'], bitrateScale: 0.85 };
const VP8: VideoChoice = { codec: 'vp8', accel: ['prefer-hardware', 'no-preference'], bitrateScale: VP8_BITRATE_SCALE };
const WEBM_EXPORT: ExportPlan = { container: 'webm', video: [VP9, VP8_FALLBACK], audio: ['opus'] };
const RECORDER_VIDEO = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;
const RECORDER_AUDIO = ['audio/webm;codecs=opus', 'audio/webm'] as const;

/**
 * MP4 that the operating system's own players open: H.264 + AAC, both from the operating system's
 * encoders. Nothing else is ever written into an MP4: no VP9 (QuickTime shows no picture) and no
 * Opus (QuickTime plays no sound). A device without either encoder is told so before the export
 * starts and offered WebM (exporter.ts checkExportSupport).
 */
const H264_AAC_MP4: ExportPlan = { container: 'mp4', video: [{ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }], audio: ['mp4a.40.2'] };

/** A · the published build: MP4 (H.264 + AAC) and WebM export, plus the macOS recorder. */
export const MP4_PROFILE: DistributionProfile = {
  id: 'mp4',
  patentPoolCodecs: true,
  exports: { mp4: H264_AAC_MP4, webm: WEBM_EXPORT },
  formats: ['mp4', 'webm'],
  defaultExport: 'mp4',
  recorderVideo: RECORDER_VIDEO,
  recorderAudio: RECORDER_AUDIO,
  nativeRecorder: true,
};

/** B · A without the macOS recorder: Chromium recording, WebM (VP9 + Opus) and MP4 (H.264 + AAC) export. */
export const WEBM_PROFILE: DistributionProfile = {
  id: 'webm',
  patentPoolCodecs: true,
  exports: { mp4: H264_AAC_MP4, webm: WEBM_EXPORT },
  formats: ['mp4', 'webm'],
  defaultExport: 'mp4',
  recorderVideo: RECORDER_VIDEO,
  recorderAudio: RECORDER_AUDIO,
  nativeRecorder: false,
};

/** Experimental · VP8 + Opus, WebM only. Same runtime as B (Electron's libvpx has both VP8 and VP9). */
export const VP8_PROFILE: DistributionProfile = {
  id: 'webm-vp8',
  patentPoolCodecs: false,
  exports: { webm: { container: 'webm', video: [VP8], audio: ['opus'] } },
  formats: ['webm'],
  defaultExport: 'webm',
  recorderVideo: ['video/webm;codecs=vp8', 'video/webm'],
  recorderAudio: RECORDER_AUDIO,
  nativeRecorder: false,
};

export const DIST: DistributionId = typeof __ZEYVOLA_DIST__ === 'string' && (__ZEYVOLA_DIST__ === 'webm' || __ZEYVOLA_DIST__ === 'webm-vp8') ? __ZEYVOLA_DIST__ : 'mp4';
/** False only in the experimental VP8 build; code behind it is dropped by the bundler there. */
export const PATENT_POOL_CODECS: boolean = DIST === 'mp4' || DIST === 'webm';
export const PROFILE: DistributionProfile = DIST === 'mp4' ? MP4_PROFILE : DIST === 'webm' ? WEBM_PROFILE : VP8_PROFILE;

/** Lowest H.264 High-profile level whose MaxMBPS and MaxFS cover the stream (ITU-T H.264 Table A-1). */
function avcCodecString(width: number, height: number, fps: number): string {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * fps;
  // [MaxMBPS, MaxFS, level_idc]: 4.0, 4.2, 5.0, 5.1, 5.2, 6.0, 6.1, 6.2
  const levels: [number, number, number][] = [
    [245_760, 8_192, 0x28], [522_240, 8_704, 0x2a], [589_824, 22_080, 0x32], [983_040, 36_864, 0x33],
    [2_073_600, 36_864, 0x34], [4_177_920, 139_264, 0x3c], [8_355_840, 139_264, 0x3d], [16_711_680, 139_264, 0x3e],
  ];
  const lvl = levels.find(([maxMbps, maxFs]) => mbps <= maxMbps && fs <= maxFs)?.[2] ?? 0x3e;
  return `avc1.6400${lvl.toString(16).padStart(2, '0')}`;
}

/** VP9 profile 0, 8-bit; level 4.1 up to ~1440p, 5.1 above (webmproject.org VP9 codec string). */
function vp9CodecString(width: number, height: number): string {
  return width * height > 2_500_000 ? 'vp09.00.51.08' : 'vp09.00.41.08';
}

/** Exact WebCodecs codec string for a choice. */
export function codecString(choice: VideoChoice, width: number, height: number, fps: number): string {
  if (choice.codec === 'avc1') {
    if (!PATENT_POOL_CODECS) throw new Error('H.264 bu dağıtımda yok');
    return avcCodecString(width, height, fps);
  }
  return choice.codec === 'vp09' ? vp9CodecString(width, height) : 'vp8';
}
