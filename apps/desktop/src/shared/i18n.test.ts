import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLang, translate } from './i18n';
import { EN } from './i18n-en';

/** Strings that read the same in both languages (codec names, units). */
const SAME = new Set(['Zeyvola', 'H.264', 'VP9', 'VP8', '30 fps', '60 fps', '1080p', '4K', 'MP4 · H.264', 'MP4 · VP9', 'WebM · VP9', 'WebM · VP8', 'Format', 'Zoom', 'V / Esc']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Every literal passed to t() or tm() in the app. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  const call = /\bt[m]?\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  for (const file of sourceFiles(join(import.meta.dirname, '..'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(call)) {
      keys.add(m[1] !== undefined ? (JSON.parse(`"${m[1]}"`) as string) : m[2]!);
    }
  }
  return [...keys];
}

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('follows the computer language when set to automatic', () => {
    expect(resolveLang('auto', ['tr-TR', 'en-US'])).toBe('tr');
    expect(resolveLang('auto', ['en-GB'])).toBe('en');
    expect(resolveLang('auto', ['de-DE', 'tr-TR'])).toBe('en');
    expect(resolveLang('auto', [])).toBe('en');
    expect(resolveLang('tr', ['en-US'])).toBe('tr');
    expect(resolveLang('en', ['tr-TR'])).toBe('en');
  });

  it('fills placeholders and falls back to Turkish', () => {
    expect(translate('en', 'Kayıt {n} saniye içinde başlıyor', { n: 3 })).toBe('Recording starts in 3 seconds');
    expect(translate('tr', 'Kayıt {n} saniye içinde başlıyor', { n: 3 })).toBe('Kayıt 3 saniye içinde başlıyor');
    expect(translate('en', 'çeviri yok')).toBe('çeviri yok');
  });

  it('has an English entry for every string in the app', () => {
    const missing = usedKeys().filter((k) => !(k in EN) && !SAME.has(k));
    expect(missing).toEqual([]);
  });

  it('keeps the same placeholders in both languages', () => {
    const broken = Object.entries(EN).filter(([tr, en]) => params(tr).join() !== params(en).join()).map(([tr]) => tr);
    expect(broken).toEqual([]);
  });
});
