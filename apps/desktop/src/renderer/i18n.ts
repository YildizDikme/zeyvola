import { useSyncExternalStore } from 'react';
import { localeOf, translate, type Lang, type Params, type SettingsInfo } from '../shared/i18n';
import { api } from './api';

let lang: Lang = 'tr';
const listeners = new Set<() => void>();

function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  for (const l of listeners) l();
}

/** Translate a Turkish source string into the current language. */
export function t(text: string, params?: Params): string {
  return translate(lang, text, params);
}

export function currentLocale(): string {
  return localeOf(lang);
}

/**
 * Subscribes a component to language changes. Used at the root of each window: a change
 * re-renders the whole tree, so every t() call picks up the new language.
 */
export function useLang(): Lang {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => lang,
  );
}

/** Loads the language before the first render and follows later changes. */
export async function initI18n(): Promise<SettingsInfo> {
  const info = await api.getSettings();
  lang = info.resolved;
  document.documentElement.lang = lang;
  api.onSettingsChanged((s) => setLang(s.resolved));
  return info;
}

/** A length of time for the interface, in the interface's language ("1 min 25 s" / "1 dk 25 sn"). */
export function durationText(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return t("{h} sa {m} dk", { h, m });
  if (m > 0) return t("{m} dk {s} sn", { m, s });
  return t("{s} sn", { s });
}
