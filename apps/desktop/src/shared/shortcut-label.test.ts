import { describe, expect, it } from 'vitest';
import { redoCombo, shortcutLabel } from './shortcut-label';

describe('shortcutLabel', () => {
  it('writes exactly the texts the app showed on macOS before', () => {
    const mac = (c: string) => shortcutLabel(c, 'darwin');
    expect(mac('mod+Z')).toBe('⌘Z');
    expect(mac('mod+shift+Z')).toBe('⇧⌘Z');
    expect(mac('shift+mod+Z')).toBe('⇧⌘Z');
    expect(mac('mod+,')).toBe('⌘,');
    expect(mac('mod+E')).toBe('⌘E');
    expect(mac('alt+shift+S')).toBe('⌥⇧S');
    expect(mac('alt+shift+P')).toBe('⌥⇧P');
    expect(mac('alt+shift+M')).toBe('⌥⇧M');
    expect(mac('mod')).toBe('⌘');
    expect(mac('shift')).toBe('⇧');
  });

  it('writes Ctrl/Alt/Shift names on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      const l = (c: string) => shortcutLabel(c, platform);
      expect(l('mod+Z')).toBe('Ctrl+Z');
      expect(l('mod+shift+Z')).toBe('Ctrl+Shift+Z');
      expect(l('mod+Y')).toBe('Ctrl+Y');
      expect(l('mod+,')).toBe('Ctrl+,');
      expect(l('mod+e')).toBe('Ctrl+E');
      expect(l('alt+shift+S')).toBe('Alt+Shift+S');
      expect(l('mod')).toBe('Ctrl');
      expect(l('shift')).toBe('Shift');
      expect(l('ctrl+mod+K')).toBe('Ctrl+K');
    }
  });

  it('uses the usual redo key of each system', () => {
    expect(shortcutLabel(redoCombo('darwin'), 'darwin')).toBe('⇧⌘Z');
    expect(shortcutLabel(redoCombo('win32'), 'win32')).toBe('Ctrl+Y');
  });
});
