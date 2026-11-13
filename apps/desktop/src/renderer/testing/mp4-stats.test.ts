import { describe, expect, it } from 'vitest';
import { Mp4Writer } from '@zeyvola/media-web';
import { avcProfileName, compareFrames, mp4Tracks, sharpness } from './mp4-stats';

/** An MP4 from the project's own writer: 2 s of "H.264" (High, level 4.0) at 1 MB/s and "AAC" at 24 kB/s. */
async function sample(): Promise<Uint8Array> {
  const parts: { d: Uint8Array; p: number | null }[] = [];
  // avcC: version 1, profile 100 (High), compatibility 0, level 40, then lengths and one empty SPS/PPS.
  const avcC = new Uint8Array([1, 100, 0, 40, 0xff, 0xe1, 0, 4, 0x67, 100, 0, 40, 1, 0, 2, 0x68, 0]);
  const w = new Mp4Writer({ video: { codec: 'avc1', width: 1920, height: 1080, description: avcC }, audio: { codec: 'mp4a', sampleRate: 48_000, channels: 2 }, sink: async (d, p) => { parts.push({ d: d.slice(), p }); } });
  for (let i = 0; i < 60; i++) await w.addVideo(new Uint8Array(1_000_000 / 30), Math.round((i * 1e6) / 30), 1e6 / 30, i % 30 === 0);
  for (let i = 0; i < 2 * 48_000 / 1024; i++) await w.addAudio(new Uint8Array(512), Math.round((i * 1024 * 1e6) / 48_000), (1024 * 1e6) / 48_000);
  await w.finish();
  let size = 0;
  let pos = 0;
  for (const x of parts) { const at = x.p ?? pos; size = Math.max(size, at + x.d.length); if (x.p === null) pos += x.d.length; }
  const out = new Uint8Array(size);
  pos = 0;
  for (const x of parts) { const at = x.p ?? pos; out.set(x.d, at); if (x.p === null) pos += x.d.length; }
  return out;
}

describe('MP4 file statistics', () => {
  it('reads each track’s codec, duration, real bit rate and the H.264 profile', async () => {
    const [video, audio] = mp4Tracks(await sample());
    expect(video).toMatchObject({ handler: 'vide', codec: 'avc1', samples: 60, avcProfile: 100, avcLevel: 40 });
    expect(video!.seconds).toBeCloseTo(2, 2);
    expect(video!.kbps).toBeCloseTo(8000, -1); // 1 MB/s
    expect(audio).toMatchObject({ handler: 'soun', codec: 'mp4a' });
    expect(audio!.kbps).toBeCloseTo(192, -1); // 512 bytes per 1024 samples at 48 kHz
    expect(avcProfileName(video!.avcProfile)).toBe('High');
    expect(avcProfileName(66)).toBe('Baseline');
  });

  it('finds nothing in a file that is not an MP4', () => {
    expect(mp4Tracks(new TextEncoder().encode('bu bir video değil'))).toEqual([]);
  });

  it('measures detail and closeness of two frames', () => {
    const w = 16;
    const h = 16;
    const edges = new Uint8ClampedArray(w * h * 4);
    const flat = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let i = 0; i < w * h; i++) { const v = (i % w) % 2 ? 255 : 0; edges.set([v, v, v, 255], i * 4); }
    expect(sharpness(edges, w, h)).toBeGreaterThan(500);
    expect(sharpness(flat, w, h)).toBe(0);
    expect(compareFrames(flat, flat).psnr).toBe(99);
    const brighter = flat.map((v, i) => (i % 4 === 3 ? v : v + 10));
    const r = compareFrames(brighter, flat);
    expect(r.meanDiff[0]).toBeCloseTo(10, 6);
    expect(r.psnr).toBeCloseTo(28.13, 1);
  });
});
