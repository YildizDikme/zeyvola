import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeVersionInfo, encodeVersionInfo, findVersionResources, setVersionInfo, versionParts } from '../../../../tools/win-version-info.mjs';
import { cached } from '../../../../tools/electron-artifacts.mjs';

const STRINGS = {
  CompanyName: 'Yıldız Dikme',
  FileDescription: 'Zeyvola',
  FileVersion: '0.1.0',
  InternalName: 'Zeyvola',
  LegalCopyright: 'Copyright © 2026 Yıldız Dikme',
  OriginalFilename: 'Zeyvola.exe',
  ProductName: 'Zeyvola',
  ProductVersion: '0.1.0',
};

describe('Windows version information', () => {
  it('lays out VS_VERSIONINFO as Microsoft documents it and reads it back', () => {
    const buf = encodeVersionInfo({ fileVersion: '0.1.0', productVersion: [0, 1, 0, 7], strings: STRINGS });
    // 6-byte header + "VS_VERSION_INFO\0" (32 bytes) = 38, padded to 40: VS_FIXEDFILEINFO starts there.
    expect(buf.readUInt32LE(40)).toBe(0xfeef04bd);
    expect(buf.readUInt16LE(0)).toBe(buf.length);
    const back = decodeVersionInfo(buf);
    expect(back.fileVersion).toEqual([0, 1, 0, 0]);
    expect(back.productVersion).toEqual([0, 1, 0, 7]);
    expect(back.strings).toEqual(STRINGS);
    expect(back.tableKey).toBe('040904b0');
    expect(back.translation).toEqual([0x0409, 0x04b0]);
  });

  it('turns version strings into four 16-bit parts', () => {
    expect(versionParts('44.8.0')).toEqual([44, 8, 0, 0]);
    expect(versionParts('1.2.3.4.5')).toEqual([1, 2, 3, 4]);
    expect(versionParts('x')).toEqual([0, 0, 0, 0]);
  });
});

// The real executable from Electron's official Windows zip (in the download cache when the Windows package was built).
const zip = cached('electron:win32:x64');
describe.skipIf(!zip || !existsSync(zip))('Electron for Windows executable', () => {
  // Unpacked once: the executable is about 250 MB.
  let exe: Buffer;
  beforeAll(() => { exe = execFileSync('unzip', ['-p', zip!, 'electron.exe'], { maxBuffer: 512 * 1024 * 1024 }); }, 120_000);
  const original = (): Buffer => Buffer.from(exe);

  it("replaces Electron's details with Zeyvola's and changes nothing else in the file", () => {
    const before = original();
    const after = Buffer.from(before);
    const [res] = setVersionInfo(after, { fileVersion: '0.1.0', productVersion: '0.1.0', strings: STRINGS });
    expect(res!.before.ProductName).toBe('Electron');
    expect(after.length).toBe(before.length);
    const { entries } = findVersionResources(after);
    const e = entries[0]!;
    const info = decodeVersionInfo(after.subarray(e.offset, e.offset + e.size));
    expect(info.strings).toEqual(STRINGS);
    expect(info.fileVersion).toEqual([0, 1, 0, 0]);
    // Only the version block and its data entry's size field may differ.
    const oldSize = findVersionResources(before).entries[0]!.size;
    for (let i = 0; i < before.length; i += 4096) {
      const end = Math.min(before.length, i + 4096);
      if (before.subarray(i, end).equals(after.subarray(i, end))) continue;
      for (let j = i; j < end; j++) {
        if (before[j] === after[j]) continue;
        const inBlock = j >= e.offset && j < e.offset + oldSize;
        const inSize = j >= e.entry + 4 && j < e.entry + 8;
        expect(inBlock || inSize).toBe(true);
      }
    }
  }, 60_000);

  it('refuses to touch a signed executable', () => {
    const buf = original();
    const pe = buf.readUInt32LE(0x3c);
    buf.writeUInt32LE(8, pe + 24 + 112 + 8 * 4 + 4); // pretend there is a certificate table
    expect(() => setVersionInfo(buf, { fileVersion: '0.1.0', productVersion: '0.1.0', strings: STRINGS })).toThrow(/İmzalı/);
  }, 60_000);
});
