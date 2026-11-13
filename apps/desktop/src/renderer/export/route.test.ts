import { describe, expect, it } from 'vitest';
import { chooseRoute, needsMfProbe, nv12Size, rgbaToNv12, toPcm16Stereo, writtenFormat, type RouteFacts } from './route';

const facts = (o: Partial<RouteFacts>): RouteFacts => ({
  format: 'mp4', platform: 'win32', includeAudio: true, hardwareH264: true, webCodecsAac: true, mfAvailable: true, webmOffered: true, ...o,
});

describe('export route', () => {
  it('1 · a hardware H.264 encoder (with AAC) writes MP4 through WebCodecs, on every platform', () => {
    expect(chooseRoute(facts({}))).toEqual({ kind: 'webcodecs' });
    expect(chooseRoute(facts({ platform: 'darwin', mfAvailable: false }))).toEqual({ kind: 'webcodecs' });
    expect(chooseRoute(facts({ webCodecsAac: false, includeAudio: false }))).toEqual({ kind: 'webcodecs' });
  });

  it('2 · Windows without a hardware encoder uses the helper with Media Foundation', () => {
    expect(chooseRoute(facts({ hardwareH264: false }))).toEqual({ kind: 'mf' });
    // No AAC in WebCodecs: Media Foundation writes both, so the sound is not lost.
    expect(chooseRoute(facts({ webCodecsAac: false }))).toEqual({ kind: 'mf' });
  });

  it('3 · otherwise WebM stands in for MP4, with the reason', () => {
    expect(chooseRoute(facts({ hardwareH264: false, mfAvailable: false }))).toEqual({ kind: 'webm-fallback', reason: 'no-h264' });
    expect(chooseRoute(facts({ webCodecsAac: false, mfAvailable: false }))).toEqual({ kind: 'webm-fallback', reason: 'no-aac' });
    // macOS has no Media Foundation path even if a probe said yes.
    expect(chooseRoute(facts({ platform: 'darwin', hardwareH264: false }))).toEqual({ kind: 'webm-fallback', reason: 'no-h264' });
  });

  it('never writes a different MP4 codec, and says so when WebM is not offered either', () => {
    expect(chooseRoute(facts({ hardwareH264: false, mfAvailable: false, webmOffered: false }))).toEqual({ kind: 'unsupported', reason: 'no-h264' });
  });

  it('WebM exports are not affected', () => {
    expect(chooseRoute(facts({ format: 'webm', hardwareH264: false, mfAvailable: false }))).toEqual({ kind: 'webcodecs' });
  });

  it('test runs can force a path; a forced helper path still needs the helper', () => {
    expect(chooseRoute(facts({ forced: 'mf' }))).toEqual({ kind: 'mf' });
    expect(chooseRoute(facts({ forced: 'mf', mfAvailable: false }))).toEqual({ kind: 'webcodecs' });
    expect(chooseRoute(facts({ forced: 'webm' }))).toEqual({ kind: 'webm-fallback', reason: 'forced' });
  });

  it('asks the Windows helper only when WebCodecs cannot write the MP4, or when a test forces it', () => {
    const p = (o: Partial<RouteFacts>) => needsMfProbe(facts(o));
    expect(p({})).toBe(false); // hardware H.264 + AAC: no helper run in normal use
    expect(p({ hardwareH264: false })).toBe(true);
    expect(p({ webCodecsAac: false })).toBe(true);
    expect(p({ webCodecsAac: false, includeAudio: false })).toBe(false);
    expect(p({ format: 'webm', hardwareH264: false })).toBe(false);
    expect(p({ forced: 'mf' })).toBe(true); // forced helper path even with hardware
    expect(p({ forced: 'webm' })).toBe(false); // the forced WebM fallback needs no probe…
    // …and still wins over the hardware encoder.
    expect(chooseRoute(facts({ forced: 'webm' }))).toEqual({ kind: 'webm-fallback', reason: 'forced' });
  });

  it('the file written is WebM only on the fallback route', () => {
    expect(writtenFormat('mp4', { kind: 'webm-fallback', reason: 'no-h264' })).toBe('webm');
    expect(writtenFormat('mp4', { kind: 'mf' })).toBe('mp4');
    expect(writtenFormat('mp4', { kind: 'webcodecs' })).toBe('mp4');
  });
});

describe('RGBA → NV12 (BT.709, limited range)', () => {
  const solid = (r: number, g: number, b: number, w = 4, h = 2) => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
    return rgbaToNv12(px, w, h);
  };
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);

  it('has the NV12 layout: a full Y plane, then interleaved U and V at half size', () => {
    expect(nv12Size(1920, 1080)).toBe(3_110_400);
    expect(solid(0, 0, 0).length).toBe(12);
  });

  it('maps black, white and grey to the limited range with neutral chroma', () => {
    const black = solid(0, 0, 0);
    const white = solid(255, 255, 255);
    near(black[0]!, 16); near(black[8]!, 128); near(black[9]!, 128);
    near(white[0]!, 235); near(white[8]!, 128); near(white[9]!, 128);
    near(solid(128, 128, 128)[0]!, 126);
  });

  it('gives the BT.709 values for the primaries', () => {
    const red = solid(255, 0, 0);
    near(red[0]!, 63); near(red[8]!, 102); near(red[9]!, 240);
    const green = solid(0, 255, 0);
    near(green[0]!, 173); near(green[8]!, 42); near(green[9]!, 26);
    const blue = solid(0, 0, 255);
    near(blue[0]!, 32); near(blue[8]!, 240); near(blue[9]!, 118);
  });

  it('averages chroma over each 2×2 block and keeps luma per pixel', () => {
    const w = 2;
    const h = 2;
    const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
    const out = rgbaToNv12(px, w, h);
    near(out[0]!, 63); near(out[1]!, 32);
    near(out[4]!, Math.round((102 + 240) / 2)); near(out[5]!, Math.round((240 + 118) / 2));
  });
});

describe('PCM for Windows\' AAC encoder', () => {
  it('interleaves 16-bit little-endian stereo and clips out-of-range samples', () => {
    const l = new Float32Array([0, 1, -1, 2]);
    const r = new Float32Array([0.5, -0.5, 0, -2]);
    const pcm = new DataView(toPcm16Stereo(l, r, 0, 4).buffer);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => pcm.getInt16(i * 2, true))).toEqual([0, 16384, 32767, -16383, -32767, 0, 32767, -32767]);
    expect(toPcm16Stereo(l, r, 2, 2).length).toBe(8);
  });
});
