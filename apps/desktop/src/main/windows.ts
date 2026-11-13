import { join } from 'node:path';
import { BrowserWindow, screen, type BrowserWindowConstructorOptions, type NativeImage } from 'electron';
import type { Rect } from '@zeyvola/project-model';

const RENDERER = join(__dirname, '..', 'renderer');
const PRELOAD = join(__dirname, 'preload.cjs');

function secure(win: BrowserWindow): BrowserWindow {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  return win;
}

const baseWebPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
};

export function createMainWindow(show = true, smoke = false, icon?: NativeImage): BrowserWindow {
  const mac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#15161A',
    title: 'Zeyvola',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(icon && !mac ? { icon } : {}),
    ...(mac ? { trafficLightPosition: { x: 18, y: 17 } } : { titleBarOverlay: { color: '#15161A', symbolColor: '#EDEBE7', height: 48 } }),
    webPreferences: { ...baseWebPreferences, ...(smoke ? { backgroundThrottling: false } : {}) },
  });
  if (smoke) win.setContentSize(1440, 900);
  secure(win);
  if (show) win.once('ready-to-show', () => win.show());
  void win.loadFile(join(RENDERER, 'index.html'));
  return win;
}

/** Hidden window that runs browser-based capture (fallback backend). */
export function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: { ...baseWebPreferences, backgroundThrottling: false },
  });
  secure(win);
  void win.loadFile(join(RENDERER, 'capture.html'));
  return win;
}

let hud: BrowserWindow | null = null;

/** Floating recording controls. Excluded from capture where the OS allows it. */
export function showHud(displayBounds: Rect): BrowserWindow {
  const width = 452;
  const height = 64;
  const x = Math.round(displayBounds.x + (displayBounds.w - width) / 2);
  const y = Math.round(displayBounds.y + (process.platform === 'darwin' ? 44 : 16));
  if (!hud || hud.isDestroyed()) {
    hud = new BrowserWindow({
      width, height, x, y,
      frame: false, transparent: true, resizable: false, movable: true, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
      backgroundColor: '#00000000',
      webPreferences: { ...baseWebPreferences, backgroundThrottling: false },
    });
    secure(hud);
    hud.setAlwaysOnTop(true, 'screen-saver');
    hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Windows: WDA_EXCLUDEFROMCAPTURE. macOS: ScreenCaptureKit ignores this; the native
    // helper excludes our windows through its content filter instead.
    hud.setContentProtection(true);
    void hud.loadFile(join(RENDERER, 'hud.html'));
    hud.once('ready-to-show', () => hud?.showInactive());
  } else {
    hud.setBounds({ x, y, width, height });
    hud.showInactive();
  }
  return hud;
}

export function hideHud(temporarily = false): void {
  if (!hud || hud.isDestroyed()) return;
  if (temporarily) hud.hide();
  else {
    // On macOS, visibleOnFullScreen in showHud turns the whole app into a background (UIElement)
    // process: no Dock icon, a menu bar that ignores clicks, windows that drag badly between
    // screens and won't go full screen. Turn it back into a normal app before the HUD goes,
    // or it stays that way until the app is restarted.
    if (process.platform === 'darwin') hud.setVisibleOnAllWorkspaces(false);
    hud.destroy();
    hud = null;
  }
}

export function hudWindow(): BrowserWindow | null {
  return hud && !hud.isDestroyed() ? hud : null;
}

export function displayFor(win: BrowserWindow) {
  return screen.getDisplayMatching(win.getBounds());
}
