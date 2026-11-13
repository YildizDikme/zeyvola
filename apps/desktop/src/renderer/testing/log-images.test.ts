// Pictures through the Windows CI log (tests/windows-env/log-images.mjs): what ci-summary.mjs writes
// must come back byte for byte from `gh run view --log`, whose lines carry a job/step/time prefix.
import { describe, expect, it } from 'vitest';
import { imageLines, parseImages } from '../../../../../tests/windows-env/log-images.mjs';

// A made-up "JPEG": its first two bytes and then every byte value, several parts long.
const bytes = Buffer.from([0xff, 0xd8, ...Array.from({ length: 9000 }, (_, i) => i % 256)]);
const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
const prefix = (l: string, i: number) => `windows\tÖzet / summary\t2026-11-13T20:43:41.${String(i).padStart(7, '0')}Z ${l}`;

describe('log-images', () => {
  it('splits a picture into numbered lines and gets the same bytes back from a prefixed log', () => {
    const lines = imageLines('2-kayit-ham', dataUrl, 1000);
    expect(lines.length).toBe(Math.ceil(bytes.toString('base64').length / 1000));
    const log = ['başka satır', ...lines.map(prefix).reverse(), 'son'].join('\r\n');
    const got = parseImages(log).get('2-kayit-ham');
    expect(got?.error).toBeUndefined();
    expect(Buffer.compare(got!.bytes!, bytes)).toBe(0);
  });

  it('reports a picture with a missing part instead of writing a broken file', () => {
    const lines = imageLines('1-ekran', dataUrl, 1000);
    const got = parseImages(lines.filter((_, i) => i !== 2).join('\n')).get('1-ekran');
    expect(got?.bytes).toBeUndefined();
    expect(got?.error).toContain('3');
  });

  it('keeps several pictures apart and refuses names that could leave the folder', () => {
    const log = [...imageLines('a', dataUrl), ...imageLines('b', 'AAEC')].join('\n');
    expect([...parseImages(log).keys()]).toEqual(['a', 'b']);
    expect([...parseImages(log).get('b')!.bytes!]).toEqual([0, 1, 2]);
    expect(() => imageLines('../x', dataUrl)).toThrow();
  });
});
