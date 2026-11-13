import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, COPYRIGHT, DEVELOPER, LICENSE_NAME, SOURCE_URL } from './brand';

const root = resolve(import.meta.dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('developer and copyright details', () => {
  it('say the same thing in the app, NOTICE, README, TRADEMARKS and the package metadata', () => {
    const desktop = JSON.parse(read('apps/desktop/package.json')) as { version: string; author: string; license: string; homepage: string };
    expect(APP_VERSION).toBe(desktop.version);
    expect(desktop.author).toBe(DEVELOPER);
    expect(COPYRIGHT).toBe(`Copyright © 2026 ${desktop.author}`); // scripts/package.mjs builds the bundle line the same way
    expect(desktop.license).toBe('PolyForm-Shield-1.0.0');
    expect(desktop.homepage).toBe(SOURCE_URL);
    expect(read('NOTICE')).toContain(`Required Notice: ${COPYRIGHT} (${SOURCE_URL})`);
    expect(read('README.md')).toContain(COPYRIGHT);
    expect(read('README.md')).toContain(LICENSE_NAME);
    expect(read('TRADEMARKS.md')).toContain(DEVELOPER);
  });
});
