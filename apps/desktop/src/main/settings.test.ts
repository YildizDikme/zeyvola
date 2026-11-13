import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const userData = await mkdtemp(join(tmpdir(), 'zeyvola-settings-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData, getPreferredSystemLanguages: () => ['tr-TR'], getLocale: () => 'tr' },
}));
const settings = await import('./settings');

afterAll(async () => { await rm(userData, { recursive: true, force: true }); });

describe('settings: last export folder', () => {
  it('remembers the folder across restarts, next to the language', async () => {
    await settings.loadSettings();
    expect(settings.getLastExportFolder()).toBeNull();
    await settings.updateSettings({ language: 'en' });
    await settings.setLastExportFolder('/Volumes/Video/Exports');
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'));
    expect(saved).toEqual({ language: 'en', lastExportFolder: '/Volumes/Video/Exports' });
    // Changing the language keeps the folder.
    await settings.updateSettings({ language: 'tr' });
    expect(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).lastExportFolder).toBe('/Volumes/Video/Exports');
  });

  it('ignores a folder that is not an absolute path', async () => {
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ language: 'tr', lastExportFolder: '../escape' }));
    vi.resetModules();
    const fresh = await import('./settings');
    await fresh.loadSettings();
    expect(fresh.getLastExportFolder()).toBeNull();
    await fresh.setLastExportFolder('relative/dir');
    expect(fresh.getLastExportFolder()).toBeNull();
  });

  it('test runs keep it in memory and never write the settings file', async () => {
    vi.resetModules();
    const fresh = await import('./settings');
    await writeFile(join(userData, 'settings.json'), '{"language":"tr"}');
    await fresh.loadSettings({ ephemeral: true });
    await fresh.setLastExportFolder('/tmp/somewhere');
    expect(fresh.getLastExportFolder()).toBe('/tmp/somewhere');
    expect(await readFile(join(userData, 'settings.json'), 'utf8')).toBe('{"language":"tr"}');
  });
});
