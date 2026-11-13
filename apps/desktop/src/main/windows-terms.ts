// Windows only. Electron for Windows brings Microsoft's d3dcompiler_47.dll (the Direct3D HLSL
// compiler that WebGL uses there). It is "Distributable Code" of the Windows SDK, whose terms ask
// the distributor to make end users agree to terms that protect it at least as much as the SDK
// license. So, while that DLL is in the package and its terms have not been accepted, the app
// shows them once, before any window opens, and only goes on after "Accept".
//
// Until then hardware acceleration stays off (main.ts), so the DLL is not loaded before the user
// has agreed. After acceptance the app restarts once with acceleration on. Declining quits.
// The terms cover only that Microsoft file; Zeyvola's own license and the open-source licenses
// (FFmpeg, LGPL-2.1) are not changed by them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { app, dialog, shell } from 'electron';
import { tm } from './settings';

/** Bumped whenever the terms text changes, so it is shown again. */
export const TERMS_VERSION = '2026-10-17';
export const TERMS_ID = 'microsoft-d3dcompiler';
export const TERMS_FILE = 'MICROSOFT-D3DCOMPILER-TERMS.txt';
const STATE_FILE = 'third-party-terms.json';

type TermsState = Record<string, { version: string; acceptedAt: string }>;

function readState(userData: string): TermsState {
  try {
    const j = JSON.parse(readFileSync(join(userData, STATE_FILE), 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as TermsState) : {};
  } catch {
    return {};
  }
}

export function termsAccepted(userData: string, version = TERMS_VERSION): boolean {
  return readState(userData)[TERMS_ID]?.version === version;
}

export function recordAcceptance(userData: string, now = new Date(), version = TERMS_VERSION): void {
  const state = readState(userData);
  state[TERMS_ID] = { version, acceptedAt: now.toISOString() };
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The terms are needed only on Windows and only while the DLL actually ships next to the app. */
export function termsNeeded(platform: string, dllPresent: boolean, accepted: boolean): boolean {
  return platform === 'win32' && dllPresent && !accepted;
}

export function microsoftDllPresent(): boolean {
  return existsSync(join(dirname(process.execPath), 'd3dcompiler_47.dll'));
}

export function termsFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'licenses', TERMS_FILE)
    : resolve(app.getAppPath(), '..', '..', 'tools', 'notices-supplement', TERMS_FILE);
}

/** Native dialog (no window, no GPU). Resolves true on "Accept". */
export async function askForTerms(): Promise<boolean> {
  const file = termsFile();
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: tm("Microsoft bileşeni koşulları"),
      message: tm("Zeyvola, Windows'ta Microsoft'un bir dosyasını kullanır"),
      detail: tm("Zeyvola'nın Windows sürümü, görüntü işleme için Microsoft'a ait d3dcompiler_47.dll dosyasını içerir. Microsoft bu dosyanın ancak kullanıcı koşullarını kabul ederse dağıtılmasına izin veriyor. Koşullar yalnızca bu dosya için geçerlidir: ayrıca dağıtmamak, tersine mühendislik yapmamak (yasanın izin verdiği durumlar dışında), garanti ve sorumluluk sınırları. Zeyvola'nın kendi lisansını ve açık kaynak bileşenlerin (FFmpeg, LGPL) size tanıdığı hakları değiştirmez.\n\nKoşulların tamamını okumak için \"Koşulları oku\" düğmesine basın. Kabul etmezseniz Zeyvola kapanır."),
      buttons: [tm("Kabul ediyorum"), tm("Koşulları oku"), tm("Kabul etmiyorum")],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) return true;
    if (response === 2) return false;
    const err = await shell.openPath(file);
    if (err) await dialog.showMessageBox({ type: 'warning', message: tm("Koşullar dosyası açılamadı"), detail: `${file}\n${err}` });
  }
}
