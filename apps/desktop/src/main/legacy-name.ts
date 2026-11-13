// The app was called "Sahne" while it was developed. The first start under the new name moves the
// old projects folder to the new one and copies the old settings file, so nothing the user made
// disappears. Projects store paths relative to their folder, so a move keeps them intact. Nothing
// is deleted, and nothing happens when the new folder already exists.
import { access, copyFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const LEGACY_NAME = 'Sahne';
export const LEGACY_PROJECTS_FOLDER = 'Sahne Projeleri';

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

export interface LegacyPaths {
  /** Parent of the projects folder (Electron: app.getPath('videos')). */
  videos: string;
  /** This app's userData folder; the old one is its sibling named LEGACY_NAME. */
  userData: string;
  projectsFolder: string;
}

/** Returns what was moved or copied, for the log. */
export async function migrateLegacyData(p: LegacyPaths): Promise<string[]> {
  const done: string[] = [];
  const oldProjects = join(p.videos, LEGACY_PROJECTS_FOLDER);
  const newProjects = join(p.videos, p.projectsFolder);
  if (oldProjects !== newProjects && await exists(oldProjects) && !(await exists(newProjects))) {
    await rename(oldProjects, newProjects);
    done.push(`${oldProjects} → ${newProjects}`);
  }
  const oldSettings = join(dirname(p.userData), LEGACY_NAME, 'settings.json');
  const newSettings = join(p.userData, 'settings.json');
  if (oldSettings !== newSettings && await exists(oldSettings) && !(await exists(newSettings))) {
    await mkdir(p.userData, { recursive: true });
    await copyFile(oldSettings, newSettings);
    done.push(`${oldSettings} → ${newSettings}`);
  }
  return done;
}
