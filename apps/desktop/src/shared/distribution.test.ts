import { describe, expect, it } from 'vitest';
import { codecString, DIST, MP4_PROFILE, PROFILE, VP8_PROFILE, WEBM_PROFILE } from './distribution';

const all = [MP4_PROFILE, WEBM_PROFILE, VP8_PROFILE];

describe('distribution profiles', () => {
  it('builds the A profile when ZEYVOLA_DIST is not set', () => {
    expect(DIST).toBe('mp4');
    expect(PROFILE).toBe(MP4_PROFILE);
  });

  it('asks for H.264 only from a hardware (operating-system) encoder, never the bundled software one', () => {
    for (const p of all) {
      for (const plan of Object.values(p.exports)) {
        for (const v of plan?.video ?? []) if (v.codec === 'avc1') expect(v.accel).toEqual(['prefer-hardware']);
      }
    }
    expect(MP4_PROFILE.exports.mp4!.video.map((v) => v.codec)).toEqual(['avc1']);
  });

  it('writes MP4 only as H.264 + AAC, in every profile that offers it (no VP9 or Opus in MP4)', () => {
    for (const p of all) {
      const plan = p.exports.mp4;
      if (!plan) continue;
      expect(plan).toMatchObject({ container: 'mp4', audio: ['mp4a.40.2'] });
      expect(plan.video.map((v) => v.codec)).toEqual(['avc1']);
      expect(p.patentPoolCodecs).toBe(true);
    }
  });

  it('the published B profile keeps the Chromium recording path: no macOS recorder', () => {
    expect(WEBM_PROFILE.nativeRecorder).toBe(false);
    expect(MP4_PROFILE.nativeRecorder).toBe(true);
    expect(WEBM_PROFILE.exports).toEqual(MP4_PROFILE.exports);
    expect(WEBM_PROFILE.formats).toEqual(['mp4', 'webm']);
  });

  it('keeps H.264, AAC and HEVC out of the VP8 profile entirely', () => {
    const text = JSON.stringify(VP8_PROFILE);
    for (const s of ['avc1', 'mp4a', 'hvc1', 'hev1', 'audio/mp4', 'video/mp4']) expect(text).not.toContain(s);
    expect(VP8_PROFILE.patentPoolCodecs).toBe(false);
    expect(VP8_PROFILE.nativeRecorder).toBe(false);
  });

  it('always offers WebM with Opus; every offered format has a plan and the default comes first', () => {
    for (const p of all) {
      expect(p.exports.webm).toMatchObject({ container: 'webm', audio: ['opus'] });
      expect(p.formats[0]).toBe(p.defaultExport);
      expect(Object.keys(p.exports).sort()).toEqual([...p.formats].sort());
    }
  });

  it('the experimental VP8 profile records and exports VP8 + Opus in WebM only, at a higher bitrate', () => {
    expect(VP8_PROFILE.formats).toEqual(['webm']);
    expect(VP8_PROFILE.exports.mp4).toBeUndefined();
    expect(VP8_PROFILE.exports.webm!.video.map((v) => v.codec)).toEqual(['vp8']);
    expect(VP8_PROFILE.recorderVideo).toEqual(['video/webm;codecs=vp8', 'video/webm']);
    expect(JSON.stringify(VP8_PROFILE)).not.toContain('vp09');
    expect(VP8_PROFILE.exports.webm!.video[0]!.bitrateScale).toBeGreaterThan(WEBM_PROFILE.exports.webm!.video[0]!.bitrateScale);
  });

  it('records through Chromium in royalty-free formats only, in every profile', () => {
    for (const p of all) {
      for (const m of [...p.recorderVideo, ...p.recorderAudio]) expect(m).toMatch(/^(video|audio)\/webm/);
    }
  });

  it('derives codec strings from size and frame rate', () => {
    expect(codecString({ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }, 1920, 1080, 30)).toBe('avc1.640028');
    expect(codecString({ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }, 1920, 1080, 60)).toBe('avc1.64002a');
    expect(codecString({ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }, 3840, 2160, 30)).toBe('avc1.640033');
    expect(codecString({ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }, 3840, 2160, 60)).toBe('avc1.640034');
    expect(codecString({ codec: 'avc1', accel: ['prefer-hardware'], bitrateScale: 1 }, 2560, 1440, 30)).toBe('avc1.640032');
    expect(codecString({ codec: 'vp09', accel: ['no-preference'], bitrateScale: 0.85 }, 1920, 1080, 60)).toBe('vp09.00.41.08');
    expect(codecString({ codec: 'vp09', accel: ['no-preference'], bitrateScale: 0.85 }, 3840, 2160, 30)).toBe('vp09.00.51.08');
    expect(codecString({ codec: 'vp8', accel: ['no-preference'], bitrateScale: 1.7 }, 640, 360, 30)).toBe('vp8');
  });
});
