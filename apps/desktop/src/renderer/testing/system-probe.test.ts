// The rules that turn the Windows probe's findings (tests/media-check/mf-check.ps1, Media
// Foundation) into problems must match av-check.swift's on macOS: the interface test asserts on
// these messages on both systems.
import { describe, expect, it } from 'vitest';
import { problemsOf } from '../../../../../tests/media-check/av-check.mjs';

const good = {
  duration: 8.06,
  video: { codec: 'avc1', decodedFrames: 241, spread: 0.4 },
  audio: { codec: 'aac ', decodedSeconds: 8.06, peak: 0.3 },
};

describe('system probe problems (Windows facts, macOS rules)', () => {
  it('accepts a decodable H.264 + AAC file of the expected length', () => {
    expect(problemsOf(good, { duration: 8.02 })).toEqual([]);
  });

  it('rejects the old VP9 + Opus "MP4" the way AVFoundation does', () => {
    const p = problemsOf({ duration: 1, video: { codec: 'VP90', decodedFrames: 0, error: 'ReadSample 0xc00d36b4' }, audio: { codec: 'Opus', decodedSeconds: 0 } });
    expect(p.some((x) => x.startsWith('görüntü H.264 değil'))).toBe(true);
    expect(p.some((x) => x.startsWith('görüntü çözülemiyor'))).toBe(true);
    expect(p.some((x) => x.startsWith('ses AAC değil'))).toBe(true);
  });

  it('reports blank pictures, silence, missing tracks and a wrong length', () => {
    expect(problemsOf({ ...good, video: { ...good.video, spread: 0.001 } })).toEqual(['çözülen kareler boş (tek renk)']);
    expect(problemsOf({ ...good, audio: { ...good.audio, peak: 0 } })).toEqual(['ses sessiz']);
    expect(problemsOf({ duration: 8, video: null, audio: null })).toEqual(['görüntü izi yok', 'ses izi yok']);
    expect(problemsOf(good, { duration: 7.5 })).toEqual(['süre 8.060 sn, beklenen 7.500 sn']);
  });

  it('passes a probe failure on (Media Foundation missing, compile error)', () => {
    expect(problemsOf({ error: 'Media Foundation: MFStartup: 0x80004005' })[0]).toBe('sonda: Media Foundation: MFStartup: 0x80004005');
  });
});
