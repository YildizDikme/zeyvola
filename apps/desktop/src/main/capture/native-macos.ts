import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { BackendInfo } from '@zeyvola/protocol';
import { tm } from '../settings';
import { HelperClient, HelperError, prepareCommand, probeFiles, recordingResult, type HelperMessage, type ProbedFile } from './helper-client';
import { RecorderCrash, type BackendResult, type BackendStartArgs, type CaptureBackend } from './types';

export function helperPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin', 'zeyvola-recorder');
  return resolve(app.getAppPath(), '..', '..', 'native', 'recorder-macos', 'bin', 'zeyvola-recorder');
}

/** The helper's error codes in the user's language; unknown codes keep the helper's text. */
function describe(e: unknown): Error {
  if (!(e instanceof HelperError)) return e as Error;
  switch (e.code) {
    case 'screen-permission':
      return new Error(tm("Ekran kaydı izni gerekli. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı bölümünde Zeyvola'yı açın, ardından Zeyvola'yı yeniden başlatın."));
    case 'camera-permission':
      return new Error(tm("Kamera izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Kamera bölümünden Zeyvola'ya izin verin."));
    case 'mic-permission':
      return new Error(tm("Mikrofon izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Mikrofon bölümünden Zeyvola'ya izin verin."));
    case 'display-not-found':
    case 'window-not-found':
      return new Error(tm("Seçilen kaynak artık mevcut değil."));
    case 'camera-not-found':
      return new Error(tm("Seçilen kamera bulunamadı."));
    case 'mic-not-found':
      return new Error(tm("Seçilen mikrofon bulunamadı."));
    case 'camera-busy':
    case 'mic-busy':
      return new Error(tm("Kamera veya mikrofon başka bir uygulama tarafından kullanılıyor."));
    case 'screen-start-timeout':
      return new Error(tm("macOS ekran yakalamayı başlatmadı. Ekran uykuda olabilir ya da bir sistem onayı yanıt bekliyor olabilir; kontrol edip yeniden deneyin."));
    case 'screen-start':
      return new Error(tm("Ekran kaydı başlatılamadı. {detail}", { detail: e.message }));
    case 'timeout':
      return new Error(tm("Kayıt yardımcısı yanıt vermedi ({type}).", { type: e.message }));
    case 'exited':
      return new Error(tm("Kayıt yardımcısı beklenmedik şekilde kapandı ({detail}).", { detail: e.message }));
    default:
      return new Error(e.message);
  }
}

/**
 * Drives the Swift helper (ScreenCaptureKit + AVFoundation). The helper writes the screen
 * without the pointer, the camera, microphone and system audio into separate files, and a
 * pointer/click log, all on one clock. Sources open during the countdown ("prepare") and
 * recording begins on "go". Events: 'level', 'status', 'error', 'interrupted', 'crashed'
 * (the helper died while recording; its files can be recovered).
 */
export class NativeMacBackend extends EventEmitter implements CaptureBackend {
  private readonly available: boolean;
  private client: HelperClient | null = null;
  private args: BackendStartArgs | null = null;
  private prepared = false;
  private recording = false;

  constructor() {
    super();
    this.available = process.platform === 'darwin' && existsSync(helperPath());
  }

  /** Built on every read so the reason follows the current language. */
  get info(): BackendInfo {
    const available = this.available;
    return {
      id: 'native-macos',
      available,
      reason: available ? undefined : process.platform !== 'darwin' ? tm("Yalnızca macOS") : tm("Yerel macOS kayıt bileşeni bu sürümde yok."),
      capabilities: { separateCursor: true, clicks: true, systemAudio: true, pause: true },
    };
  }

  private onMessage(m: HelperMessage): void {
    if (m.type === 'status') {
      this.emit('level', m.micLevel);
      this.emit('status', { droppedFrames: m.dropped });
    } else if (m.type === 'interrupted') {
      // macOS ended the screen stream (permission withdrawn, display gone, …): keep what was recorded.
      this.emit('interrupted', new Error(tm("Ekran kaydı macOS tarafından durduruldu; o ana kadar kaydedilenler saklanıyor.")));
    } else if (m.type === 'error') {
      this.emit('error', describe(new HelperError(m.code ?? 'internal', m.message)));
    }
  }

  /** Opens the screen, camera and microphone without recording (runs during the countdown). */
  async prepare(args: BackendStartArgs): Promise<void> {
    this.args = args;
    this.prepared = false;
    this.recording = false;
    const client = new HelperClient(helperPath());
    this.client = client;
    client.on('message', (m: HelperMessage) => this.onMessage(m));
    client.on('exit', (code: number | null, tail: string) => {
      if (this.client !== client) return;
      this.client = null;
      if (this.recording) {
        this.recording = false;
        this.emit('crashed', new RecorderCrash(describe(new HelperError('exited', `${code}${tail ? `; ${tail}` : ''}`)).message));
      }
    });
    try {
      await client.open();
      const ready = client.waitFor('ready', 120_000); // macOS may be showing a permission dialog
      client.send(prepareCommand(args, process.pid));
      await ready;
      this.prepared = true;
    } catch (e) {
      client.close(500);
      if (this.client === client) this.client = null;
      throw describe(e);
    }
  }

  async start(args: BackendStartArgs): Promise<void> {
    if (!this.prepared || !this.client || this.args !== args) await this.prepare(args);
    const client = this.client;
    if (!client) throw describe(new HelperError('exited', 'prepare'));
    try {
      const started = client.waitFor('started', 10_000);
      client.send({ cmd: 'go' });
      await started;
      this.recording = true;
    } catch (e) {
      throw describe(e);
    }
  }

  async pause(): Promise<void> { this.client?.send({ cmd: 'pause' }); }
  async resume(): Promise<void> { this.client?.send({ cmd: 'resume' }); }
  mark(): void { this.client?.send({ cmd: 'mark' }); }

  async stop(): Promise<BackendResult> {
    const args = this.args;
    const client = this.client;
    if (!args || !client) throw describe(new HelperError('exited', 'stop'));
    this.recording = false;
    try {
      const done = client.waitFor('stopped', 60_000);
      client.send({ cmd: 'stop' });
      const m = (await done) as Extract<HelperMessage, { type: 'stopped' }>;
      return recordingResult(m, args, 'native-macos');
    } catch (e) {
      // Died while closing the files: what reached the disk can still be recovered.
      if (e instanceof HelperError && e.code === 'exited') throw new RecorderCrash(describe(e).message);
      throw describe(e);
    } finally {
      client.close();
      this.client = null;
      this.prepared = false;
    }
  }

  probe(dir: string): Promise<ProbedFile[]> {
    return probeFiles(helperPath(), dir);
  }

  async cancel(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.prepared = false;
    this.recording = false;
    if (!client) return;
    client.send({ cmd: 'cancel' });
    client.close(1500);
  }
}
