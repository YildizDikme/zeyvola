import { describe, expect, it } from 'vitest';
import { Mp4Writer, vpcC } from './mp4';
import { WebmWriter } from './webm';

/** In-memory sink that honours positioned writes. */
function memorySink() {
  let buf = new Uint8Array(0);
  return {
    sink: async (data: Uint8Array, position: number | null) => {
      const at = position ?? buf.length;
      if (at + data.length > buf.length) {
        const next = new Uint8Array(at + data.length);
        next.set(buf);
        buf = next;
      }
      buf.set(data, at);
    },
    bytes: () => buf,
  };
}

interface Box { type: string; start: number; size: number; header: number }

function boxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!);
    let header = 8;
    if (size === 1) { size = v.getUint32(p + 8) * 2 ** 32 + v.getUint32(p + 12); header = 16; }
    expect(size).toBeGreaterThanOrEqual(header);
    out.push({ type, start: p, size, header });
    p += size;
  }
  expect(p).toBe(end);
  return out;
}

function child(b: Uint8Array, parent: Box, type: string, skip = 0): Box {
  const found = boxes(b, parent.start + parent.header + skip, parent.start + parent.size).find((x) => x.type === type);
  if (!found) throw new Error(`${type} yok`);
  return found;
}

describe('MP4 writer', () => {
  it('produces a consistent box tree with correct sample offsets', async () => {
    const m = memorySink();
    const w = new Mp4Writer({
      video: { codec: 'avc1', width: 1920, height: 1080, description: new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]) },
      audio: { codec: 'mp4a', sampleRate: 48000, channels: 2 },
      sink: m.sink,
    });
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 90; i++) {
      const f = new Uint8Array(100 + i).fill(i);
      frames.push(f);
      await w.addAudio(new Uint8Array(20).fill(200), (i * 1e6) / 30, 1e6 / 30);
      await w.addVideo(f, (i * 1e6) / 30, 1e6 / 30, i % 30 === 0);
    }
    const size = await w.finish();
    const b = m.bytes();
    expect(b.length).toBe(size);
    const top = boxes(b);
    expect(top.map((x) => x.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const moov = top[2]!;
    const traks = boxes(b, moov.start + 8, moov.start + moov.size).filter((x) => x.type === 'trak');
    expect(traks).toHaveLength(2);
    const stbl = child(b, child(b, child(b, traks[0]!, 'mdia'), 'minf'), 'stbl');
    const v = new DataView(b.buffer);
    const co64 = child(b, stbl, 'co64');
    const stsz = child(b, stbl, 'stsz');
    expect(v.getUint32(co64.start + 12)).toBe(90);
    // Every chunk offset must point at the exact bytes we wrote for that frame.
    for (const i of [0, 1, 45, 89]) {
      const off = v.getUint32(co64.start + 16 + i * 8) * 2 ** 32 + v.getUint32(co64.start + 20 + i * 8);
      const sz = v.getUint32(stsz.start + 20 + i * 4);
      expect(sz).toBe(100 + i);
      expect(Array.from(b.subarray(off, off + sz))).toEqual(Array.from(frames[i]!));
    }
    const stss = child(b, stbl, 'stss');
    expect(v.getUint32(stss.start + 12)).toBe(3); // keyframes 1, 31, 61
  });
});

describe('MP4 writer with royalty-free codecs (VP9 + Opus)', () => {
  it('builds vpcC from the codec string, with the binding defaults', () => {
    // profile 0, level 4.1, 8-bit, 4:2:0 colocated, BT.709 primaries/transfer/matrix, legal range, no init data.
    expect(Array.from(vpcC('vp09.00.41.08'))).toEqual([0, 41, (8 << 4) | (1 << 1), 1, 1, 1, 0, 0]);
    expect(Array.from(vpcC('vp09.02.10.10.01.09.16.09.01'))).toEqual([2, 10, (10 << 4) | (1 << 1) | 1, 9, 16, 9, 0, 0]);
    expect(() => vpcC('avc1.640028')).toThrow();
    expect(() => vpcC('vp09.00.41.07')).toThrow();
  });

  it('builds vpcC for VP8 (profile 0, 8-bit only)', () => {
    expect(Array.from(vpcC('vp08.00.10.08'))).toEqual([0, 10, (8 << 4) | (1 << 1), 1, 1, 1, 0, 0]);
    expect(() => vpcC('vp08.01.10.08')).toThrow();
    expect(() => vpcC('vp08.00.10.10')).toThrow();
  });

  it('writes a vp08 sample entry with vpcC for VP8', async () => {
    const m = memorySink();
    const w = new Mp4Writer({ video: { codec: 'vp08', width: 640, height: 360, codecString: 'vp08.00.10.08' }, sink: m.sink });
    for (let i = 0; i < 5; i++) await w.addVideo(new Uint8Array(40).fill(i), (i * 1e6) / 30, 1e6 / 30, i === 0);
    await w.finish();
    const b = m.bytes();
    const top = boxes(b);
    const trak = boxes(b, top[2]!.start + 8, top[2]!.start + top[2]!.size).find((x) => x.type === 'trak')!;
    const stsd = child(b, child(b, child(b, child(b, trak, 'mdia'), 'minf'), 'stbl'), 'stsd');
    const vEntry = boxes(b, stsd.start + 16, stsd.start + stsd.size)[0]!;
    expect(vEntry.type).toBe('vp08');
    const vpcc = child(b, vEntry, 'vpcC', 78);
    expect(Array.from(b.subarray(vpcc.start + 12, vpcc.start + vpcc.size))).toEqual(Array.from(vpcC('vp08.00.10.08')));
  });

  it('writes vp09/vpcC and Opus/dOps sample entries without any H.264 or AAC box', async () => {
    const m = memorySink();
    const w = new Mp4Writer({
      video: { codec: 'vp09', width: 1280, height: 720, codecString: 'vp09.00.41.08' },
      audio: { codec: 'opus', sampleRate: 48000, channels: 2 },
      sink: m.sink,
    });
    for (let i = 0; i < 30; i++) {
      await w.addAudio(new Uint8Array(20).fill(7), i * 20_000, 20_000);
      await w.addVideo(new Uint8Array(50 + i).fill(i), (i * 1e6) / 30, 1e6 / 30, i === 0);
    }
    const size = await w.finish();
    const b = m.bytes();
    expect(b.length).toBe(size);
    const top = boxes(b);
    const ftyp = top[0]!;
    const brands = String.fromCharCode(...b.subarray(ftyp.start + 16, ftyp.start + ftyp.size));
    expect(brands).not.toContain('avc1');
    const traks = boxes(b, top[2]!.start + 8, top[2]!.start + top[2]!.size).filter((x) => x.type === 'trak');
    const stsd = (t: Box) => child(b, child(b, child(b, child(b, t, 'mdia'), 'minf'), 'stbl'), 'stsd');
    const vEntry = boxes(b, stsd(traks[0]!).start + 16, stsd(traks[0]!).start + stsd(traks[0]!).size)[0]!;
    expect(vEntry.type).toBe('vp09');
    const vpcc = child(b, vEntry, 'vpcC', 78);
    expect(b[vpcc.start + 8]).toBe(1); // FullBox version 1
    expect(Array.from(b.subarray(vpcc.start + 12, vpcc.start + vpcc.size))).toEqual(Array.from(vpcC('vp09.00.41.08')));
    const aEntry = boxes(b, stsd(traks[1]!).start + 16, stsd(traks[1]!).start + stsd(traks[1]!).size)[0]!;
    expect(aEntry.type).toBe('Opus');
    const dops = child(b, aEntry, 'dOps', 28);
    expect(b[dops.start + 9]).toBe(2); // output channel count
    const text = String.fromCharCode(...b);
    for (const fourcc of ['avcC', 'mp4a', 'esds', 'hvcC']) expect(text).not.toContain(fourcc);
  });
});

describe('WebM writer', () => {
  function readVint(b: Uint8Array, p: number, keepMarker: boolean): [number, number] {
    const first = b[p]!;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + b[p + i]!;
    return [v, len];
  }

  it('writes a well-formed segment with clusters, cues and duration', async () => {
    const m = memorySink();
    const w = new WebmWriter({ video: { codec: 'V_VP9', width: 1280, height: 720 }, audio: { codec: 'A_OPUS', sampleRate: 48000, channels: 2 }, sink: m.sink });
    for (let i = 0; i < 120; i++) {
      await w.addAudio(new Uint8Array(30).fill(1), i * 20_000);
      await w.addVideo(new Uint8Array(200).fill(i), (i * 1e6) / 30, i % 30 === 0);
    }
    const size = await w.finish(33);
    const b = m.bytes();
    expect(b.length).toBe(size);
    // EBML header then Segment.
    let [id, n] = readVint(b, 0, true);
    expect(id).toBe(0x1a45dfa3);
    let [len, ln] = readVint(b, n, false);
    let p = n + ln + len;
    [id, n] = readVint(b, p, true);
    expect(id).toBe(0x18538067);
    [len, ln] = readVint(b, p + n, false);
    const dataStart = p + n + ln;
    expect(dataStart + len).toBe(b.length); // patched segment size
    // Walk top-level children of the segment.
    const seen: number[] = [];
    p = dataStart;
    while (p < b.length) {
      [id, n] = readVint(b, p, true);
      [len, ln] = readVint(b, p + n, false);
      seen.push(id);
      p += n + ln + len;
    }
    expect(p).toBe(b.length);
    expect(seen[0]).toBe(0x114d9b74); // SeekHead
    expect(seen).toContain(0x1549a966); // Info
    expect(seen).toContain(0x1654ae6b); // Tracks
    expect(seen.filter((x) => x === 0x1f43b675).length).toBe(4); // a cluster per keyframe second
    expect(seen[seen.length - 1]).toBe(0x1c53bb6b); // Cues
    // Duration ≈ 3.97 s.
    const dv = new DataView(b.buffer);
    let found = false;
    for (let i = 0; i < 400; i++) {
      if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) {
        expect(dv.getFloat64(i + 3)).toBeCloseTo(3967 + 33 - 1, -1);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
