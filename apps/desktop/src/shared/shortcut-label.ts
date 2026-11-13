/**
 * How a keyboard shortcut is written for the user, per platform. Every shortcut shown in the
 * app (buttons, hints, help, tray menu) is written through here, so it matches the keys that
 * really work on that system:
 *   macOS:           ⌘Z, ⇧⌘Z, ⌥⇧S   (symbols, no separator, order ⌃ ⌥ ⇧ ⌘ as on macOS menus)
 *   Windows, Linux:  Ctrl+Z, Ctrl+Y, Alt+Shift+S
 *
 * A combination is written as modifiers and one key joined by "+": "mod+Z", "alt+shift+S",
 * "mod+,". `mod` is ⌘ on macOS and Ctrl elsewhere (the editor accepts either: metaKey || ctrlKey).
 * A modifier alone ("mod", "shift") names just that key, for hints like "⌘ + scroll".
 *
 * Pure: used by the renderer (window.zeyvola.platform) and by main (process.platform).
 */

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'mod';

const ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'mod'];
const MAC: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' };
const OTHER: Record<Modifier, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', mod: 'Ctrl' };

const isMac = (platform: string) => platform === 'darwin';

/** The label for `combo` ("mod+shift+Z") on `platform` (a Node process.platform value). */
export function shortcutLabel(combo: string, platform: string): string {
  const mods = new Set<Modifier>();
  let key = '';
  for (const p of combo.split('+')) {
    const m = p.toLowerCase();
    if ((ORDER as readonly string[]).includes(m)) mods.add(m as Modifier);
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  // On other systems ctrl and mod are the same key: write it once.
  if (!isMac(platform) && mods.has('mod')) { mods.delete('mod'); mods.add('ctrl'); }
  const names = ORDER.filter((m) => mods.has(m)).map((m) => (isMac(platform) ? MAC : OTHER)[m]);
  if (isMac(platform)) return names.join('') + key;
  return [...names, ...(key ? [key] : [])].join('+');
}

/**
 * Redo: ⇧⌘Z on macOS; Ctrl+Y elsewhere, the usual key there (Ctrl+Shift+Z works too).
 */
export function redoCombo(platform: string): string {
  return isMac(platform) ? 'mod+shift+Z' : 'mod+Y';
}
