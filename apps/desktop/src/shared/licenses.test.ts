import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTICES_PATH, ROOT, collect, inventoryGaps, renderJson, renderMarkdown, shippedPackages, shippedProblems,
} from '../../../../tools/third-party-notices.mjs';

const data = collect();

describe('third-party licenses', () => {
  it('ships exactly the production dependency closure of the desktop app', () => {
    const names = shippedPackages().map((p) => p.name);
    // react-dom brings scheduler; workspace packages are our own code and are not listed.
    expect(names).toEqual(['react', 'react-dom', 'scheduler', 'zod']);
  });

  it('has a license text and an allowed license for every shipped component', () => {
    expect(shippedProblems(data)).toEqual([]);
    for (const p of data.packages) expect(p.text).toMatch(/Permission is hereby granted|Licensed under/);
    expect(data.electron.text).toMatch(/Copyright \(c\) Electron contributors/);
  });

  it('keeps docs/THIRD_PARTY_NOTICES.md up to date (run `node tools/third-party-notices.mjs --write`)', () => {
    expect(readFileSync(join(ROOT, NOTICES_PATH), 'utf8')).toBe(renderMarkdown(data));
  });

  it('lists every installed package in docs/licenses/inventory.md (run `node tools/license-inventory.mjs` after review)', () => {
    expect(inventoryGaps()).toEqual({ missingFromInventory: [], notInstalled: [] });
  });

  it('ships the Chromium notices with FFmpeg, OpenH264, libvpx and Opus entries', () => {
    expect(data.electron.chromium.entries).toBeGreaterThan(500);
    for (const c of data.codecs.filter((x) => x.chromiumTitle)) expect(c.inChromiumNotice).toBe(true);
  });

  it('never presents a codec patent question as resolved', () => {
    for (const c of data.codecs) {
      expect(['legal-review', 'low-risk-unverified']).toContain(c.status);
      expect(`${c.patent.tr} ${c.patent.en}`).not.toMatch(/\b(çözüldü|resolved|lisanslı değil gerek yok|no license needed)\b/i);
    }
    expect(data.codecs.find((c) => c.id === 'h264-encode')?.status).toBe('legal-review');
    expect(data.codecs.find((c) => c.id === 'aac-encode')?.status).toBe('legal-review');
  });

  it('catches a newly added dependency that the inventory does not list yet', () => {
    const fake = mkdtempSync(join(tmpdir(), 'zeyvola-lic-'));
    mkdirSync(join(fake, 'docs', 'licenses'), { recursive: true });
    copyFileSync(join(ROOT, 'docs', 'licenses', 'inventory.md'), join(fake, 'docs', 'licenses', 'inventory.md'));
    const pkg = join(fake, 'node_modules', '.pnpm', 'yeni-paket@1.2.3', 'node_modules', 'yeni-paket');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'yeni-paket', version: '1.2.3', license: 'MIT' }));
    expect(inventoryGaps(fake).missingFromInventory).toEqual(['yeni-paket@1.2.3']);
  });

  it('refuses to ship a component under a license outside the policy', () => {
    const gpl = { ...data.packages[0]!, name: 'kopyalayan-paket', version: '1.0.0', license: 'GPL-3.0' };
    expect(shippedProblems({ ...data, packages: [...data.packages, gpl] })).toEqual([
      'kopyalayan-paket@1.0.0: lisans "GPL-3.0" dağıtım politikasında yok — kullanıcıya bildirin',
    ]);
  });

  it('gives the app screen the same packages and the app\'s own license with its required notices', () => {
    const json = JSON.parse(renderJson(data)) as { ownLicense: string | null; ownNotice: string[]; packages: { name: string }[] };
    expect(json.ownLicense).toBe('PolyForm Shield License 1.0.0');
    expect(json.ownNotice.some((l) => l.startsWith('Required Notice:'))).toBe(true);
    expect(json.ownNotice.some((l) => l.startsWith('Licensor Line of Business:'))).toBe(true);
    expect(json.packages.map((p) => p.name)).toEqual(data.packages.map((p) => p.name));
  });
});
