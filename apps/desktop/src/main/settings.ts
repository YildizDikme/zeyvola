import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { app } from 'electron';
import { DEFAULT_SETTINGS, resolveLang, translate, type AppSettings, type Lang, type Params, type SettingsInfo } from '../shared/i18n';
import { writeFileAtomic } from './fsutil';

let settings: AppSettings = { ...DEFAULT_SETTINGS };
/** The folder the last export was saved to through the save dialog (absolute path). */
let lastExportFolder: string | null = null;
let lang: Lang = 'tr';
const listeners = new Set<(info: SettingsInfo) => void>();
/** Smoke runs keep settings in memory so they never touch the user's settings file. */
let ephemeral = false;

function file(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function systemLocales(): string[] {
  const preferred = app.getPreferredSystemLanguages();
  return preferred.length > 0 ? preferred : [app.getLocale()];
}

export function settingsInfo(): SettingsInfo {
  return { language: settings.language, resolved: lang, system: systemLocales() };
}

export async function loadSettings(opts: { ephemeral?: boolean; language?: AppSettings['language'] } = {}): Promise<void> {
  ephemeral = !!opts.ephemeral;
  if (opts.language) settings = { ...settings, language: opts.language };
  if (!ephemeral) {
    try {
      const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<AppSettings>;
      if (raw.language === 'auto' || raw.language === 'tr' || raw.language === 'en') settings = { ...settings, language: raw.language };
      const folder = (raw as { lastExportFolder?: unknown }).lastExportFolder;
      if (typeof folder === 'string' && isAbsolute(folder)) lastExportFolder = folder;
    } catch { /* first run: defaults */ }
  }
  lang = resolveLang(settings.language, systemLocales());
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<SettingsInfo> {
  settings = { ...settings, ...patch };
  lang = resolveLang(settings.language, systemLocales());
  await persist();
  const info = settingsInfo();
  for (const l of listeners) l(info);
  return info;
}

async function persist(): Promise<void> {
  if (ephemeral) return;
  await writeFileAtomic(file(), JSON.stringify({ ...settings, ...(lastExportFolder ? { lastExportFolder } : {}) }, null, 2));
}

export function getLastExportFolder(): string | null {
  return lastExportFolder;
}

/** Remembers where the user saved an export (kept in memory only during test runs). */
export async function setLastExportFolder(dir: string): Promise<void> {
  if (!isAbsolute(dir) || dir === lastExportFolder) return;
  lastExportFolder = dir;
  await persist();
}

export function onSettingsChanged(fn: (info: SettingsInfo) => void): void {
  listeners.add(fn);
}

/** Translates a main-process string into the current language. */
export function tm(text: string, params?: Params): string {
  return translate(lang, text, params);
}

export function currentLang(): Lang {
  return lang;
}
