import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyData } from './legacy-name';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function setup(): Promise<{ videos: string; userData: string }> {
  dir = await mkdtemp(join(tmpdir(), 'zeyvola-legacy-'));
  const videos = join(dir, 'Movies');
  const support = join(dir, 'Application Support');
  await mkdir(join(videos, 'Sahne Projeleri', 'p1', 'media'), { recursive: true });
  await writeFile(join(videos, 'Sahne Projeleri', 'p1', 'project.json'), '{"name":"p1"}');
  await mkdir(join(support, 'Sahne'), { recursive: true });
  await writeFile(join(support, 'Sahne', 'settings.json'), '{"language":"en"}');
  return { videos, userData: join(support, 'Zeyvola') };
}

describe('moving data from the development name', () => {
  it('moves the old projects folder and copies the old settings once', async () => {
    const p = await setup();
    const done = await migrateLegacyData({ ...p, projectsFolder: 'Zeyvola Projeleri' });
    expect(done).toHaveLength(2);
    expect(await readFile(join(p.videos, 'Zeyvola Projeleri', 'p1', 'project.json'), 'utf8')).toBe('{"name":"p1"}');
    expect(await readdir(p.videos)).toEqual(['Zeyvola Projeleri']);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"language":"en"}');
    // The old settings stay where they were; a second start changes nothing.
    expect(await readFile(join(dir, 'Application Support', 'Sahne', 'settings.json'), 'utf8')).toBe('{"language":"en"}');
    expect(await migrateLegacyData({ ...p, projectsFolder: 'Zeyvola Projeleri' })).toEqual([]);
  });

  it('leaves both folders alone when the new one already exists', async () => {
    const p = await setup();
    await mkdir(join(p.videos, 'Zeyvola Projeleri'), { recursive: true });
    await mkdir(p.userData, { recursive: true });
    await writeFile(join(p.userData, 'settings.json'), '{"language":"tr"}');
    expect(await migrateLegacyData({ ...p, projectsFolder: 'Zeyvola Projeleri' })).toEqual([]);
    expect((await readdir(p.videos)).sort()).toEqual(['Sahne Projeleri', 'Zeyvola Projeleri']);
    expect(await readFile(join(p.userData, 'settings.json'), 'utf8')).toBe('{"language":"tr"}');
  });
});
