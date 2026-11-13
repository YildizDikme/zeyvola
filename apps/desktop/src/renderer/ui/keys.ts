/** Shortcut labels for this computer's system (shared/shortcut-label.ts): ⌘Z on macOS, Ctrl+Z elsewhere. */
import { redoCombo, shortcutLabel } from '../../shared/shortcut-label';
import { api } from '../api';

/** "mod+Z" → "⌘Z" on macOS, "Ctrl+Z" on Windows and Linux. */
export const keyLabel = (combo: string): string => shortcutLabel(combo, api.platform());

/** The redo shortcut usual on this system: ⇧⌘Z on macOS, Ctrl+Y elsewhere. */
export const redoLabel = (): string => keyLabel(redoCombo(api.platform()));

/** The three global recording shortcuts (main.ts registers them as Alt+Shift+S/P/M everywhere). */
export const RECORDING_KEYS = { stop: 'alt+shift+S', pause: 'alt+shift+P', mark: 'alt+shift+M' } as const;
