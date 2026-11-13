import { shell, systemPreferences } from 'electron';
import type { PermissionInfo, PermissionStatus } from '@zeyvola/protocol';

function mapStatus(s: string): PermissionStatus {
  switch (s) {
    case 'granted': return 'granted';
    case 'denied': return 'denied';
    case 'restricted': return 'restricted';
    case 'not-determined': return 'not-determined';
    default: return 'unknown';
  }
}

export function getPermissions(): PermissionInfo {
  if (process.platform === 'darwin') {
    return {
      screen: mapStatus(systemPreferences.getMediaAccessStatus('screen')),
      camera: mapStatus(systemPreferences.getMediaAccessStatus('camera')),
      microphone: mapStatus(systemPreferences.getMediaAccessStatus('microphone')),
      // Mouse events via a global monitor need no extra permission on macOS.
      input: 'granted',
    };
  }
  if (process.platform === 'win32') {
    return {
      screen: 'granted',
      camera: mapStatus(systemPreferences.getMediaAccessStatus('camera')),
      microphone: mapStatus(systemPreferences.getMediaAccessStatus('microphone')),
      input: 'granted',
    };
  }
  return { screen: 'unknown', camera: 'unknown', microphone: 'unknown', input: 'unknown' };
}

export async function requestPermission(kind: 'camera' | 'microphone' | 'screen'): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (kind === 'screen') {
    // macOS has no programmatic request for screen recording; the first capture prompts.
    return systemPreferences.getMediaAccessStatus('screen') === 'granted';
  }
  return systemPreferences.askForMediaAccess(kind);
}

const MAC_PANES: Record<string, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  input: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

const WIN_PANES: Record<string, string> = {
  camera: 'ms-settings:privacy-webcam',
  microphone: 'ms-settings:privacy-microphone',
  screen: 'ms-settings:privacy-graphicscaptureprogrammatic',
  input: 'ms-settings:privacy',
};

/** Opens the OS privacy pane so the user can change the setting themselves. */
export async function openPermissionSettings(kind: string): Promise<void> {
  const url = process.platform === 'darwin' ? MAC_PANES[kind] : process.platform === 'win32' ? WIN_PANES[kind] : undefined;
  if (url) await shell.openExternal(url);
}
