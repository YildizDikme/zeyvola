import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('./settings', () => ({ tm: (s: string) => s }));

const { TERMS_ID, TERMS_VERSION, recordAcceptance, termsAccepted, termsNeeded } = await import('./windows-terms');

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
});
