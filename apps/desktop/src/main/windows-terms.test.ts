import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('./settings', () => ({ tm: (s: string) => s }));

const { DLL_NAME, DLL_PENDING, TERMS_ID, TERMS_VERSION, activateDll, dllFiles, microsoftDllPresent, recordAcceptance, startupAction, termsAccepted, termsNeeded } = await import('./windows-terms');

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'zeyvola-terms-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Windows Microsoft terms', () => {
  it('asks only on Windows, only while the DLL ships, only until accepted', () => {
    expect(termsNeeded('win32', true, false)).toBe(true);
    expect(termsNeeded('win32', true, true)).toBe(false);
    expect(termsNeeded('win32', false, false)).toBe(false);
    expect(termsNeeded('darwin', true, false)).toBe(false);
  });

  it('remembers acceptance of this version and asks again for a new one', () => {
    const d = temp();
    expect(termsAccepted(d)).toBe(false);
    recordAcceptance(d, new Date('2026-10-17T10:00:00Z'));
    expect(termsAccepted(d)).toBe(true);
    expect(termsAccepted(d, `${TERMS_VERSION}-2`)).toBe(false);
    const saved = JSON.parse(readFileSync(join(d, 'third-party-terms.json'), 'utf8'));
    expect(saved[TERMS_ID]).toEqual({ version: TERMS_VERSION, acceptedAt: '2026-10-17T10:00:00.000Z' });
  });

  it('treats a damaged state file as not accepted', () => {
    const d = temp();
    writeFileSync(join(d, 'third-party-terms.json'), '{bozuk');
    expect(termsAccepted(d)).toBe(false);
    recordAcceptance(d);
    expect(termsAccepted(d)).toBe(true);
  });

  it('ships the DLL under a name Windows does not load, and asks before anything else', () => {
    expect(DLL_PENDING).toBe('d3dcompiler_47.dll.terms-pending');
    const d = temp();
    writeFileSync(join(d, DLL_PENDING), 'dll');
    expect(dllFiles(d)).toEqual({ active: false, pending: true });
    expect(microsoftDllPresent(d)).toBe(true);
    expect(startupAction('win32', dllFiles(d), false)).toBe('ask');
    expect(startupAction('darwin', dllFiles(d), false)).toBe('none');
    expect(startupAction('win32', { active: false, pending: false }, false)).toBe('none');
  });

  it('after acceptance the DLL gets its real name; after an update an earlier acceptance is enough', () => {
    const d = temp();
    writeFileSync(join(d, DLL_PENDING), 'new');
    expect(startupAction('win32', dllFiles(d), true)).toBe('activate');
    expect(activateDll(d)).toEqual({ ok: true });
    expect(readdirSync(d)).toEqual([DLL_NAME]);
    expect(startupAction('win32', dllFiles(d), true)).toBe('none');
    // An update over the same folder: the new version's pending copy replaces the old one.
    writeFileSync(join(d, DLL_PENDING), 'newer');
    expect(startupAction('win32', dllFiles(d), true)).toBe('activate');
    expect(activateDll(d)).toEqual({ ok: true });
    expect(readFileSync(join(d, DLL_NAME), 'utf8')).toBe('newer');
    expect(existsSync(join(d, DLL_PENDING))).toBe(false);
  });

  it('a DLL under its real name without acceptance (development Electron, old package) still asks', () => {
    expect(startupAction('win32', { active: true, pending: false }, false)).toBe('ask');
    expect(startupAction('win32', { active: true, pending: false }, true)).toBe('none');
  });

  it('reports the folder when the DLL cannot be renamed, and leaves the pending file alone', () => {
    const d = temp();
    writeFileSync(join(d, DLL_PENDING), 'dll');
    // Windows ignores a folder's mode bits; there the same situation is a deny entry in the folder's
    // access list (icacls, part of Windows): nobody may add a file to it, so the rename fails.
    const win = process.platform === 'win32';
    const icacls = (...args: string[]) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [d, ...args], { stdio: 'ignore' });
    if (win) icacls('/deny', '*S-1-1-0:(AD,WD)');
    else chmodSync(d, 0o555);
    try {
      expect(activateDll(d)).toMatchObject({ ok: false, dir: d });
      expect(dllFiles(d)).toEqual({ active: false, pending: true });
    } finally {
      if (win) icacls('/remove:d', '*S-1-1-0');
      else chmodSync(d, 0o755);
    }
  });
});
