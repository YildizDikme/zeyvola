/**
 * Interface test (`pnpm uitest`): the main flow, driven through the interface the way a person
 * uses it — buttons are found by their visible text or accessible name and clicked.
 *
 *   project list → open the project → edit (zoom tool, undo/redo, split, play) →
 *   automatic zoom (clear, generate) → export (finish one, pick another folder, cancel one) →
 *   back to the list
 *
 * Every exported MP4 is also opened with the operating system's own decoders (tests/media-check:
 * AVFoundation on macOS, Media Foundation on Windows), the way QuickTime or the Windows player sees
 * it: Chromium plays VP9-in-MP4 happily, QuickTime shows no picture. The packaged app's Chromium has
 * no AAC (or, without a GPU, H.264) decoder, so an MP4's picture and sound are judged by that probe.
 * A device without an H.264 hardware encoder cannot write MP4 at all: the export window must say so
 * before anything starts and offer WebM; the test checks that and goes on with WebM.
 *
 * The editor's state is only read, to check what each click did. `pnpm smoke` stays the test of
 * the parts (compositor, privacy, codecs, timeline gestures); this one checks that the parts
 * work together from the first screen to the exported file.
 */
import { parseProject, sequenceDuration } from '@zeyvola/project-model';
import { secondsToTicks } from '@zeyvola/timing';
import { TICKS_PER_SECOND } from '@zeyvola/timing';
import { Mp4Writer } from '@zeyvola/media-web';
import { PROFILE, DIST } from '../../shared/distribution';
import { api } from '../api';
import { renderStill } from '../export/exporter';
import type { EditorStore } from '../state/editor-store';
import { avcProfileName, compareFrames, mp4Tracks, sharpness } from './mp4-stats';
import { t } from '../i18n';
import { recordLikeBrowser } from '../smoke-fixtures';
import {
  all, button, click, cpuNow, cpuPercent, createSampleProject, currentEditor, decodeSound, frame, invoke, key, mediaUrl, Missing, option, peak, pressAt, probeVideo, q, screenshot, sleep, text, until, type Check,
} from './harness';

export async function runUiTest(): Promise<unknown> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: performance.now() - t0, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      const shot = await screenshot(`hata-${checks.length + 1}`, 100).catch(() => null);
      if (shot) shots.push(shot);
      checks.push({ name, ok: false, ms: performance.now() - t0, detail: e instanceof Missing ? e.message : (e as Error).message });
      return false;
    }
  };
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };

  // A sample recording made the way the Chromium recording path makes them, on disk before the
  // interface is touched: the list must show it like any project made earlier.
  const env = await invoke<{ realCapture: boolean; only: string | null; expectRoute: string | null }>('smoke:realRecording', { op: 'env' });
  /** ZEYVOLA_UITEST_ONLY=export: only the project list and the export steps (CI's extra runs). */
  const editing = env.only !== 'export';
  const sample = await createSampleProject(8, 'Arayüz testi', recordLikeBrowser);
  const fileBase = () => currentEditor(sample.id)!.store.getState().mediaBase;

  const opened = await step('Proje listesi: örnek proje görünür ve tıklayınca düzenleyicide açılır', async () => {
    click(button(t("Yenile")), 'Yenile düğmesi');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === 'Arayüz testi'), 8000);
    expect(card, 'proje kartı listede yok');
    // Test mode uses a fresh temporary projects folder: the sample is the only project listed.
    const cards = all('.project-card').map((c) => text(q('.project-meta strong', c)));
    expect(cards.length === 1, `listede ${cards.length} proje var: ${cards.join(', ')}`);
    click(q('.project-thumb', card!), 'proje kartı');
    expect(await until(() => q('.editor') && currentEditor(sample.id), 10_000), 'düzenleyici açılmadı');
    expect(text(q('.project-title')) === 'Arayüz testi', `başlık: "${text(q('.project-title'))}"`);
    return `${cards.length} proje kartı: ${cards[0]}`;
  });
  if (!opened) return { suite: 'ui', ok: false, checks, shots, dist: DIST };
  const { store } = currentEditor(sample.id)!;
  const autoZooms = () => store.project.zooms.filter((z) => z.origin === 'auto').length;
  const manualZooms = () => store.project.zooms.filter((z) => z.origin === 'manual').length;

  if (editing) await step('İlk açılış: otomatik zoom önerileri zaman çizelgesinde görünür', async () => {
    expect(await until(() => autoZooms() > 0, 12_000), 'öneri oluşmadı');
    expect(await until(() => all('.tl-item.tl-zoom.is-auto').length === autoZooms(), 3000), `çizelgede ${all('.tl-item.tl-zoom.is-auto').length}, projede ${autoZooms()} öneri`);
    await until(() => store.getState().save === 'saved', 5000);
    return `${autoZooms()} öneri`;
  });

  if (editing) await step('Düzenleme: zoom aracıyla önizlemeye basınca elle zoom eklenir; geri al ve yinele çalışır', async () => {
    // A moment without a zoom, so the press adds one instead of re-aiming an existing one.
    key('Home');
    click(option(t("Araç"), t("Zoom")), 'Zoom aracı');
    expect(await until(() => store.getState().tool === 'zoom', 2000), 'zoom aracı açılmadı');
    const before = store.project.zooms.map((z) => ({ ...z }));
    const ids = (zs: readonly { id: string }[]) => zs.map((z) => z.id).sort().join(',');
    pressAt(q('.preview-overlay'), 0.3, 0.4, 'önizleme');
    const added = await until(() => store.project.zooms.find((z) => z.origin === 'manual'), 3000);
    expect(added, 'elle zoom eklenmedi');
    expect(manualZooms() === 1, `${manualZooms()} elle zoom var, 1 bekleniyordu`);
    expect(added!.start <= store.getState().playhead && store.getState().playhead < added!.end, 'elle zoom oynatma imlecinde değil');
    // A manual zoom replaces the suggestions it overlaps, and only those: the total is
    // before + 1 − replaced, not before + 1.
    const overlaps = (a: { start: number; end: number }) => a.start < added!.end && added!.start < a.end;
    const replaced = before.filter((z) => z.origin === 'auto' && overlaps(z));
    const kept = before.filter((z) => !replaced.includes(z));
    expect(ids(store.project.zooms.filter((z) => z.id !== added!.id)) === ids(kept), `kalan zoom'lar beklenenden farklı (önce ${before.length}, yerine geçen ${replaced.length})`);
    expect(store.project.zooms.length === before.length + 1 - replaced.length, `toplam ${store.project.zooms.length}, beklenen ${before.length + 1 - replaced.length}`);
    expect(await until(() => all('.tl-item.tl-zoom').length === store.project.zooms.length, 3000), `çizelgede ${all('.tl-item.tl-zoom').length}, projede ${store.project.zooms.length} zoom`);
    const withManual = ids(store.project.zooms);
    click(button(t("Geri al (⌘Z)")), 'Geri al');
    expect(await until(() => ids(store.project.zooms) === ids(before), 3000), 'geri al önceki zoom\'ları geri getirmedi');
    expect(await until(() => all('.tl-item.tl-zoom').length === before.length, 3000), 'geri aldıktan sonra çizelge güncellenmedi');
    click(button(t("Yinele (⇧⌘Z)")), 'Yinele');
    expect(await until(() => ids(store.project.zooms) === withManual, 3000), 'yinele elle zoom\'u geri getirmedi');
    click(option(t("Araç"), t("Seç")), 'Seç aracı');
    return `${before.length} zoom → elle 1 eklendi, ${replaced.length} öneri yerini verdi → ${store.project.zooms.length} zoom`;
  });

  if (editing) await step('Düzenleme: oynat düğmesi önizlemeyi oynatır, zaman göstergesi ilerler, duraklat durdurur', async () => {
    key('Home');
    await sleep(300);
    const shown = () => text(q('.timecode'));
    const at0 = shown();
    click(button(t("Oynat")), 'Oynat düğmesi');
    expect(await until(() => store.getState().playing, 2000), 'oynatma başlamadı');
    await sleep(1500);
    click(button(t("Duraklat")), 'Duraklat düğmesi');
    expect(await until(() => !store.getState().playing, 2000), 'oynatma durmadı');
    const sec = store.getState().playhead / TICKS_PER_SECOND;
    expect(sec > 0.9 && sec < 2.2, `1,5 sn oynatma sonunda imleç ${sec.toFixed(2)} sn'de`);
    expect(shown() !== at0, 'zaman göstergesi değişmedi');
    const still = store.getState().playhead;
    await sleep(300);
    expect(store.getState().playhead === still, 'duraklatınca imleç ilerlemeye devam etti');
    return `imleç ${sec.toFixed(2)} sn`;
  });

  if (editing) await step('Düzenleme: S tuşu klibi oynatma imlecinden böler, geri al birleştirir', async () => {
    const before = store.project.sequence.segments.length;
    key('s');
    expect(await until(() => store.project.sequence.segments.length === before + 1, 2000), 'klip bölünmedi');
    expect(await until(() => all('.tl-seg.tl-seg-screen').length === before + 1, 3000), 'bölünen klip çizelgede görünmüyor');
    key('z', { metaKey: true });
    expect(await until(() => store.project.sequence.segments.length === before, 2000), 'geri al bölmeyi kaldırmadı');
  });

  if (editing) await step('Otomatik zoom: Zoom sekmesinde "Önerileri temizle" ve "Önerileri oluştur" çalışır, elle zoom\'a dokunmaz', async () => {
    click(option(t("Ayar grubu"), t("Zoom")), 'Zoom sekmesi');
    const before = autoZooms();
    click(await until(() => button(t("Önerileri temizle")), 3000), 'Önerileri temizle');
    expect(await until(() => autoZooms() === 0, 3000), 'öneriler temizlenmedi');
    expect(manualZooms() === 1, 'temizleme elle eklenen zoom\'u da sildi');
    const t0 = performance.now();
    click(button(t("Önerileri oluştur")), 'Önerileri oluştur');
    expect(await until(() => autoZooms() > 0, 8000, 10), 'öneriler oluşmadı');
    const ms = performance.now() - t0;
    expect(manualZooms() === 1, 'öneri üretimi elle eklenen zoom\'u değiştirdi');
    // Suggestions never overlap each other or the manual zoom.
    const zs = [...store.project.zooms].sort((a, b) => a.start - b.start);
    expect(zs.every((z, i) => i === 0 || zs[i - 1]!.end <= z.start), 'zoom\'lar üst üste bindi');
    expect(await until(() => all('.tl-item.tl-zoom.is-auto').length === autoZooms(), 3000), 'öneriler çizelgede görünmüyor');
    return `${before} öneri temizlendi, ${autoZooms()} öneri ${ms.toFixed(0)} ms'de geldi`;
  });

  const expected = () => sequenceDuration(store.project) / TICKS_PER_SECOND;
  let ext: 'mp4' | 'webm' = PROFILE.defaultExport;
  /** Set when this device cannot write MP4 (no H.264 hardware encoder): the window's message. */
  let mp4Unavailable: string | null = null;
  let route = 'webcodecs';
  let encoderLine = '';
  let exportStart = 0;
  let cpuBefore = await cpuNow();
  /** Numbers of the first export (CI summary): route, speed, file and picture quality. */
  let exportFacts: Record<string, unknown> | null = null;
  let firstFolder = '';
  const exportedUrl = (n = 1) => mediaUrl(fileBase(), `exports/Arayüz testi 16x9${n > 1 ? ` (${n})` : ''}.${ext}`);
  /** The system's own decoders on an MP4 (WebM is not a QuickTime format; Chromium checks those). */
  const systemProbe = async (path: string): Promise<AvCheck | null> => {
    if (ext !== 'mp4') return null;
    const r = await invoke<AvCheck>('smoke:avCheck', { path, duration: expected() });
    if (r.skipped) return null;
    expect(r.ok, `${r.engine ?? 'sistem sondası'}: ${r.problems.join('; ')}`);
    return r;
  };
  const describe = (r: AvCheck | null): string => (r
    ? `${r.engine}: ${r.video?.codec} ${r.video?.decodedFrames} kare çözüldü, ${r.audio?.codec.trim()} ${r.audio?.decodedSeconds?.toFixed(2)} sn`
    : ext === 'mp4' ? 'sistem sondası yok' : 'WebM: sistem sondası yok');
  const systemCheck = async (path: string): Promise<string> => describe(await systemProbe(path));
  // Shown with the system's separators; compared with '/' (Windows writes '\').
  const donePath = (): string => (q('.export-done span')?.getAttribute('title') ?? '').replace(/\\/g, '/');

  await step(`Dışa aktarma: pencereden ${ext.toUpperCase()} 1080p30 dosyası alınır ve oynatılabilir`, async () => {
    // Export-only runs skip the editing steps: the first automatic zoom suggestions must have arrived
    // (and been saved) before the export, or the file and the reference frame show different projects.
    if (!editing) await until(() => autoZooms() > 0, 12_000);
    await until(() => store.getState().save === 'saved', 5000);
    click(button(t("Dışa aktar"), q('.topbar-right')!), 'üst çubuktaki Dışa aktar');
    const dialog = await until(() => q('.export-modal'), 3000);
    expect(dialog, 'dışa aktarma penceresi açılmadı');
    click(option(t("Kare hızı"), t("30 fps"), dialog!), '30 fps');
    await frame();
    // The window decides the route before anything starts (export/route.ts): hardware H.264,
    // Windows' Media Foundation encoders ("Windows yazılım kodlayıcısı"), or WebM said plainly.
    const footer = () => q('.export-modal footer')!;
    const decided = await until(() => q('.export-unsupported', dialog!) ?? (button(t("Dışa aktar"), footer()) && q('.export-encoder', dialog!)), 20_000);
    expect(decided, 'pencere hangi kodlayıcıyla yazılacağını söylemedi');
    expect(!decided!.classList.contains('export-unsupported'), `${ext.toUpperCase()} yazılamıyor: ${text(decided)}`);
    encoderLine = text(q('.export-encoder', dialog!));
    const fallback = q('.export-fallback', dialog!);
    route = fallback ? 'webm-fallback' : /Windows/.test(encoderLine) ? 'mf' : 'webcodecs';
    if (env.expectRoute) expect(route === env.expectRoute, `yol ${route}, beklenen ${env.expectRoute} · "${encoderLine}"${fallback ? ` · "${text(fallback)}"` : ''}`);
    if (fallback) {
      // WebM instead of MP4: the window says so, names the .webm file, and the export can start.
      mp4Unavailable = text(fallback);
      expect(ext === 'mp4', `${ext} için WebM bildirimi`);
      expect(/WebM/.test(mp4Unavailable) && /\.webm/.test(mp4Unavailable), `bildirim WebM dosyasını söylemiyor: "${mp4Unavailable}"`);
      ext = 'webm';
      expect(await until(() => text(q('.export-target-text strong')).endsWith('.webm'), 3000), 'kayıt yeri .webm değil');
    }
    cpuBefore = await cpuNow();
    exportStart = performance.now();
    click(button(t("Dışa aktar"), footer()), 'penceredeki Dışa aktar');
    expect(await until(() => q('.export-progress .bar') || q('.export-done') || q('.export-progress .is-error'), 10_000, 20), 'ilerleme çubuğu görünmedi');
    const end = await until(() => q('.export-done') ?? q('.export-progress .is-error'), 150_000, 50);
    expect(end, 'dışa aktarma 150 sn içinde bitmedi');
    expect(end!.classList.contains('export-done'), `hata: ${text(end)}`);
    const seconds = (performance.now() - exportStart) / 1000;
    const cpu = cpuPercent(cpuBefore, await cpuNow());
    expect(button(t("Klasörde göster"), dialog!), '"Klasörde göster" düğmesi yok');
    if (mp4Unavailable) expect(q('.export-fallback-done'), 'bitişte "MP4 yerine WebM olarak kaydedildi" notu yok');
    const done = text(q('.export-done span'));
    expect(/MB/.test(done), `bitiş satırında dosya boyutu yok: "${done}"`);
    expect(donePath().endsWith(`/exports/Arayüz testi 16x9.${ext}`), `dosya yolu: "${donePath()}"`);
    firstFolder = donePath().slice(0, donePath().lastIndexOf('/'));
    // An MP4 is judged by the system's decoders; Chromium's view is reported next to it. A WebM
    // (or an MP4 on a system without a probe) is judged by Chromium.
    const system = await systemProbe(donePath());
    const chromium = await probeVideo(exportedUrl(), expected() / 2);
    const file = system
      ? { duration: system.duration, width: Math.round(system.video?.width ?? 0), height: Math.round(system.video?.height ?? 0), spread: system.video?.spread ?? 0 }
      : chromium;
    if (!system) expect(chromium.ok, 'dışa aktarılan dosya açılamadı');
    // Never shorter than the timeline by more than one frame (1/30 s). Longer by at most 0.12 s:
    // the Opus encoder pads the last packets and the writers do not trim that tail (about 0.09 s
    // measured), so the file reads a little longer than the picture.
    const diff = file.duration - expected();
    expect(diff > -1 / 30 && diff < 0.12, `dosya ${file.duration.toFixed(3)} sn, zaman çizelgesi ${expected().toFixed(3)} sn`);
    expect(file.width === 1920 && file.height === 1080, `boyut ${file.width}×${file.height}`);
    expect(file.spread > 0.02, `ortadaki kare tek renk (parlaklık yayılımı ${file.spread.toFixed(3)})`);
    let soundSeconds: number;
    if (system) {
      soundSeconds = system.audio?.decodedSeconds ?? 0;
      expect((system.audio?.peak ?? 0) > 0.01, `ses sessiz (tepe ${(system.audio?.peak ?? 0).toFixed(4)})`);
    } else {
      const sound = await decodeSound(exportedUrl()).catch((e: Error) => { throw new Error(`ses çözülemedi: ${e.message}`); });
      soundSeconds = sound.duration;
      expect(peak(sound) > 0.01, `ses sessiz (tepe ${peak(sound).toFixed(4)})`);
    }
    expect(soundSeconds > expected() - 0.05 && soundSeconds < expected() + 0.12, `ses ${soundSeconds.toFixed(2)} sn, zaman çizelgesi ${expected().toFixed(2)} sn`);
    // What the file itself says (boxes) and how its picture compares with the frame it should show.
    const bytes = new Uint8Array(await (await fetch(exportedUrl())).arrayBuffer());
    const tracks = ext === 'mp4' ? mp4Tracks(bytes) : [];
    const v = tracks.find((x) => x.handler === 'vide');
    const a = tracks.find((x) => x.handler === 'soun');
    const quality = chromium.ok ? await pictureQuality(store, exportedUrl(), expected() / 2).catch((e: Error) => ({ error: e.message })) : { error: 'Chromium bu dosyayı çözemiyor' };
    exportFacts = {
      route, encoder: encoderLine, format: ext, seconds: Math.round(seconds * 10) / 10, framesPerSecond: Math.round(((expected() * 30) / seconds) * 10) / 10, cpuPercent: Math.round(cpu),
      bytes: bytes.length, fileKbps: Math.round((bytes.length * 8) / file.duration / 1000),
      ...(v ? { video: { codec: v.codec, profile: avcProfileName(v.avcProfile), level: v.avcLevel, kbps: Math.round(v.kbps), frames: v.samples } } : {}),
      ...(a ? { audio: { codec: a.codec, kbps: Math.round(a.kbps) } } : {}),
      quality, ...(mp4Unavailable ? { fallback: mp4Unavailable } : {}),
    };
    if (route === 'mf') {
      expect(v?.codec === 'avc1' && a?.codec === 'mp4a', `Media Foundation dosyası H.264 + AAC değil: ${tracks.map((x) => x.codec).join(', ')}`);
      // bitrateFor: 1080p30 high quality is 12 Mbit/s; a software encoder may stay below it on simple pictures.
      expect(v!.kbps > 2_000 && v!.kbps < 16_000, `görüntü bit hızı ${Math.round(v!.kbps)} kbit/sn (hedef 12 000)`);
      expect(a!.kbps > 150 && a!.kbps < 230, `ses bit hızı ${Math.round(a!.kbps)} kbit/sn (hedef 192)`);
    }
    if ('psnr' in quality) {
      expect(quality.psnr > 24, `çözülen kare beklenenden çok farklı (PSNR ${quality.psnr.toFixed(1)} dB)`);
      expect(quality.sharpnessRatio > 0.5, `çözülen kare bulanık (keskinlik oranı ${quality.sharpnessRatio.toFixed(2)})`);
    }
    const shot = await screenshot('disa-aktarma-bitti', 200);
    if (shot) shots.push(shot);
    const viewer = system ? ` · Chromium ${chromium.ok ? `da açtı (${chromium.width}×${chromium.height})` : 'açamadı (bu pakette çözücüsü yok)'}` : '';
    return `${done}, ${file.duration.toFixed(2)} sn (çizelge ${expected().toFixed(2)}), ${file.width}×${file.height}, ses ${soundSeconds.toFixed(2)} sn · ${describe(system)}${viewer} · ${JSON.stringify(exportFacts)}`;
  });

  // Test runs never open the system save dialog: "Değiştir…" picks a temporary folder outside
  // the project, standing in for the user's choice (main.ts export:chooseTarget).
  let chosenFolder = '';
  await step('Kayıt yeri: "Değiştir…" ile seçilen klasör pencerede görünür, dosya oraya yazılır', async () => {
    const dialog = q('.export-modal');
    expect(dialog, 'dışa aktarma penceresi kapalı');
    expect(await until(() => text(q('.export-target-text strong')).endsWith(`.${ext}`), 3000), `kayıt yeri görünmüyor: "${text(q('.export-target'))}"`);
    click(button(t("Değiştir…"), q('.export-target')!), 'Değiştir…');
    expect(await until(() => text(q('.export-target-text span')).endsWith('Seçilen klasör'), 3000), `seçilen klasör görünmüyor: "${text(q('.export-target-text span'))}"`);
    const shot = await screenshot('disa-aktarma-kayit-yeri', 200);
    if (shot) shots.push(shot);
    click(button(t("Dışa aktar"), q('.export-modal footer')!), 'penceredeki Dışa aktar');
    // The previous export's "Ready" line goes away first; only then wait for this one's.
    expect(await until(() => !q('.export-done'), 5000, 10), 'dışa aktarma başlamadı');
    const end = await until(() => q('.export-done') ?? q('.export-progress .is-error'), 150_000, 50);
    expect(end?.classList.contains('export-done'), `hata: ${text(end) || text(q('.export-progress'))}`);
    const path = donePath();
    chosenFolder = path.slice(0, path.lastIndexOf('/'));
    expect(chosenFolder.endsWith('/Seçilen klasör') && !chosenFolder.includes('/exports'), `dosya başka yere yazıldı: "${path}"`);
    const files = await invoke<string[]>('smoke:listDir', { path: chosenFolder });
    expect(files.length === 1 && files[0] === `Arayüz testi 16x9.${ext}`, `klasörde: ${files.join(', ') || 'hiçbir şey'}`);
    const system = await systemCheck(path);
    // The folder stays for the next export: the window offers a fresh name in it.
    expect(await until(() => text(q('.export-target-text strong')) === `Arayüz testi 16x9 (2).${ext}`, 3000), `sonraki ad: "${text(q('.export-target-text strong'))}"`);
    return `${path.slice(path.indexOf('/Seçilen klasör'))} · ${system}`;
  });

  await step('Dışa aktarma: İptal yarım dosyayı siler, pencere yeniden kullanılabilir', async () => {
    const dialog = q('.export-modal');
    expect(dialog, 'dışa aktarma penceresi kapalı');
    click(button(t("Dışa aktar"), q('.export-modal footer')!), 'penceredeki Dışa aktar');
    click(await until(() => button(t("İptal"), dialog!), 5000, 10), 'İptal');
    expect(await until(() => text(q('.export-progress')).includes(t("İptal edildi; yarım dosya silindi.")), 15_000, 50), `iptal mesajı yok: "${text(q('.export-progress'))}"`);
    expect(!(await probeVideo(exportedUrl(2))).ok, 'iptal edilen dosya diskte kaldı');
    // The Media Foundation path writes "<name>.<random>.zeyvola-part.mp4" while it works.
    if (firstFolder) {
      const left = (await invoke<string[]>('smoke:listDir', { path: firstFolder })).filter((f) => /zeyvola-part|\.part$/i.test(f));
      expect(left.length === 0, `iptalden sonra yarım dosya kaldı: ${left.join(', ')}`);
    }
    if (chosenFolder) {
      const files = await invoke<string[]>('smoke:listDir', { path: chosenFolder });
      expect(files.length === 1 && files[0] === `Arayüz testi 16x9.${ext}`, `iptalden sonra seçilen klasörde: ${files.join(', ')}`);
    }
    // The window asks the encoders again after a cancel; on a slow machine that takes a moment.
    const again = await until(() => button(t("Dışa aktar"), q('.export-modal footer')!), 10_000);
    const state = all<HTMLButtonElement>('button', q('.export-modal footer')!).map((b) => `${text(b)}${b.disabled ? ' (devre dışı)' : ''}`).join(', ');
    expect(again, `iptalden 10 sn sonra Dışa aktar düğmesi yok; alt çubuk: ${state || 'boş'}; ${text(q('.export-unsupported')) || ''}`);
    click(button(t("Kapat"), dialog!), 'pencereyi kapat');
    expect(await until(() => !q('.export-modal'), 2000), 'pencere kapanmadı');
  });

  if (editing) await step('Projelere dön: değişiklikler kaydedilir, proje listede küçük resmiyle durur', async () => {
    const saved = JSON.stringify([...store.project.zooms].sort((a, b) => a.start - b.start));
    click(button(t("Projelere dön")), 'Projelere dön');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === 'Arayüz testi'), 8000);
    expect(card, 'proje listede yok');
    expect(await until(() => q('.project-thumb img', card!), 5000), 'küçük resim yok');
    click(q('.project-thumb', card!), 'proje kartı');
    const again = await until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
    expect(again, 'proje yeniden açılmadı');
    // What was edited is what comes back from disk.
    const p = again!.store.project;
    expect(p.zooms.filter((z) => z.origin === 'manual').length === 1 && p.zooms.filter((z) => z.origin === 'auto').length > 0, `yeniden açınca ${p.zooms.length} zoom`);
    expect(JSON.stringify([...p.zooms].sort((a, b) => a.start - b.start)) === saved, 'diskten gelen zoom\'lar kapatmadan öncekiyle aynı değil');
    return `${p.zooms.length} zoom kayıtlı`;
  });

  if (editing) await step('Sistem sondası kendini kanıtlar: eski sürümün VP9 + Opus\'lu MP4\'ünde "görüntü çözülemiyor" der', async () => {
    if (PROFILE.defaultExport !== 'mp4') return 'WebM dağıtımı: atlandı';
    // What the published build wrote as "MP4" until 2026-11-13 (vp09 + Opus boxes).
    await invoke('smoke:writeFile', { projectId: sample.id, path: 'exports/eski-vp9.mp4', data: await oldStyleMp4() });
    const r = await invoke<AvCheck>('smoke:avCheck', { projectId: sample.id, path: 'exports/eski-vp9.mp4' });
    if (r.skipped) return `sistem sondası yok: ${r.problems.join('; ')}`;
    expect(!r.ok, 'sonda VP9\'lu MP4\'ü kabul etti');
    expect(r.problems.some((p) => p.startsWith('görüntü çözülemiyor')), `sorunlar: ${r.problems.join('; ')}`);
    expect(r.problems.some((p) => p.startsWith('ses AAC değil')), `sorunlar: ${r.problems.join('; ')}`);
    return `${r.engine}: ${r.problems.join('; ')}`;
  });

  // Only when asked (CI on Windows): macOS needs the screen recording permission, which a test
  // run never asks for.
  let realCapture: RealCapture | null = null;
  if (editing && env.realCapture) {
    await step('Gerçek ekran kaydı (Chromium yolu): birkaç saniyelik kayıt dosyaları yazılır, görüntü boş değil, tıklamalar imleç günlüğünde', async () => {
      realCapture = await recordScreen(shots);
      return realCapture.summary;
    });
    const rc = realCapture as RealCapture | null;
    if (rc?.screen && rc.display) {
      // A display recording must keep the display's shape (zoom targets and clicks are fractions of it).
      const { screen, display } = rc;
      checks.push({
        name: 'Gerçek ekran kaydı: video ekranın en-boy oranında (kırpılmış ya da sıkıştırılmış değil)',
        ok: Math.abs(screen.width / screen.height - display.w / display.h) < 0.02,
        detail: `ekran ${display.w}×${display.h} (ölçek ${display.scale}), istenen (ideal) ${display.w * display.scale}×${display.h * display.scale}, kaynak kaydı (getSettings) ${rc.source?.width}×${rc.source?.height}, video ${screen.width}×${screen.height}, kenar bantları ${screen.bars ? `sol ${screen.bars.left} sağ ${screen.bars.right} üst ${screen.bars.top} alt ${screen.bars.bottom} px` : 'ölçülemedi'}`,
      });
    }
  }

  return { suite: 'ui', ok: checks.every((c) => c.ok), checks, shots, dist: DIST, ...(env.only ? { only: env.only } : {}), ...(exportFacts ? { exportFacts } : {}), ...(mp4Unavailable ? { mp4Unavailable } : {}), ...(realCapture ? { realCapture } : {}) };
}

interface AvCheck {
  ok: boolean;
  skipped?: boolean;
  /** AVFoundation (macOS) or Media Foundation (Windows). */
  engine?: string;
  problems: string[];
  duration: number;
  video: { codec: string; decodedFrames: number; width?: number; height?: number; spread?: number } | null;
  audio: { codec: string; decodedSeconds?: number; peak?: number } | null;
}

/** One second of VP9 + Opus in MP4, as the published build wrote "MP4" before 2026-11-13. */
async function oldStyleMp4(): Promise<Uint8Array> {
  const width = 640;
  const height = 360;
  const parts: { d: Uint8Array; p: number | null }[] = [];
  const audio: { codec: 'opus'; sampleRate: number; channels: number; description?: Uint8Array } = { codec: 'opus', sampleRate: 48_000, channels: 2 };
  const w = new Mp4Writer({ video: { codec: 'vp09', width, height, codecString: 'vp09.00.41.08' }, audio, sink: async (d, p) => { parts.push({ d: d.slice(), p }); } });
  let chain = Promise.resolve();
  const venc = new VideoEncoder({
    output: (c) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); const ts = c.timestamp; const key = c.type === 'key'; chain = chain.then(() => w.addVideo(d, ts, 33_333, key)); },
    error: (e) => { throw e; },
  });
  venc.configure({ codec: 'vp09.00.41.08', width, height, bitrate: 2e6, framerate: 30 });
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  for (let i = 0; i < 30; i++) {
    g.fillStyle = '#204060'; g.fillRect(0, 0, width, height);
    g.fillStyle = '#f0c040'; g.fillRect(40 + i * 10, 120, 120, 120);
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30), duration: 33_333 });
    venc.encode(f, { keyFrame: i === 0 });
    f.close();
  }
  await venc.flush();
  venc.close();
  const aenc = new AudioEncoder({
    output: (c, meta) => {
      const d = new Uint8Array(c.byteLength); c.copyTo(d);
      if (meta?.decoderConfig?.description) audio.description = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
      const ts = c.timestamp; const dur = c.duration ?? 20_000;
      chain = chain.then(() => w.addAudio(d, ts, dur));
    },
    error: (e) => { throw e; },
  });
  aenc.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 96_000 });
  const n = 48_000;
  const pcm = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) pcm[i] = pcm[n + i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.3;
  aenc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: n, numberOfChannels: 2, timestamp: 0, data: pcm }));
  await aenc.flush();
  aenc.close();
  await chain;
  await w.finish();
  let size = 0;
  let pos = 0;
  for (const x of parts) { const at = x.p ?? pos; size = Math.max(size, at + x.d.length); if (x.p === null) pos += x.d.length; }
  const out = new Uint8Array(size);
  pos = 0;
  for (const x of parts) { const at = x.p ?? pos; out.set(x.d, at); if (x.p === null) pos += x.d.length; }
  return out;
}

interface RealCapture {
  summary: string;
  backend: string | null;
  clicksCapability: boolean;
  seconds: number;
  screen: { width: number; height: number; duration: number; frames: number; spread: number; black: boolean; bars: Bars | null } | null;
  /** What the recording says about its screen video, and the display it recorded. */
  source: { width?: number; height?: number; fps?: number; seconds: number } | null;
  display: { w: number; h: number; scale: number } | null;
  mic: { duration: number; peak: number } | null;
  cursor: { moves: number; downs: number; buttons: string };
  driver: { clicks: number; matched: number; worstOffset: number } | null;
}

/**
 * Records the main display for about six seconds through the Chromium path (backend "web"), as
 * the recording screen does, with the synthetic microphone. An outside driver
 * (tests/real-capture-web/windows-clicks.ps1) clicks while the "recording" marker exists; its
 * clicks must come back in the cursor log at the same place. A black or empty picture fails.
 */
async function recordScreen(shots: string[]): Promise<RealCapture> {
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };
  const backends = await api.backends();
  const web = backends.find((b) => b.id === 'web');
  const display = (await api.sources()).find((s) => s.kind === 'display');
  expect(display, 'kaydedilecek ekran listede yok');
  const mic = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput');
  await api.startCapture({
    projectName: 'Gerçek kayıt', target: { kind: 'display', sourceId: display!.id, displayId: display!.displayId, label: display!.name },
    cameraDeviceId: null, cameraLabel: null, micDeviceId: mic?.deviceId ?? null, micLabel: mic?.label ?? null,
    systemAudio: false, fps: 30, quality: 'standard', countdown: 0, backend: 'web',
  });
  const recording = await untilAsync(async () => (await api.captureState()).phase === 'recording', 30_000);
  const state = await api.captureState();
  expect(recording, `kayıt başlamadı: ${state.phase}${state.message ? ` (${state.message})` : ''}`);
  await invoke('smoke:realRecording', { op: 'signal', name: 'recording' });
  const seconds = 6;
  await sleep(seconds * 1000);
  await invoke('smoke:realRecording', { op: 'signal', name: 'stopped' });
  const result = await api.stopCapture();
  expect(result, 'kayıt durdurulunca sonuç gelmedi');
  const opened = await api.openProject(result!.projectId);
  const project = parseProject(opened.json);
  const rec = project.recordings[result!.recordingId];
  expect(rec, 'kayıt projede yok');
  const url = (rel: string) => mediaUrl(opened.mediaBase, rel);

  let screen: RealCapture['screen'] = null;
  const src = rec!.sources.screen;
  if (src) {
    const kept = await invoke<string>('smoke:realRecording', { op: 'keep', projectId: project.id, path: src.file, as: `gercek-kayit-ekran.${src.file.split('.').pop()}` });
    shots.push(kept);
    const v = await probeVideo(url(src.file), 2.5);
    // MediaRecorder's WebM has no duration in its header: Chromium reports Infinity until it has
    // looked at the end of the file.
    const duration = Number.isFinite(v.duration) ? v.duration : await durationBySeeking(url(src.file));
    screen = { width: v.width, height: v.height, duration, frames: await countFrames(url(src.file)), spread: v.spread, black: !(v.spread > 0.01), bars: await sideBars(url(src.file), 2.5) };
  }
  let micInfo: RealCapture['mic'] = null;
  if (rec!.sources.mic) {
    const sound = await decodeSound(url(rec!.sources.mic.file)).catch(() => null);
    micInfo = sound ? { duration: sound.duration, peak: peak(sound) } : { duration: 0, peak: 0 };
  }
  const log = rec!.cursorFile ? await fetch(url(rec!.cursorFile)).then((r) => r.text()) : '';
  const events = log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { e: string; x: number; y: number; b?: string });
  const downs = events.filter((e) => e.e === 'd');
  const cursor = { moves: events.filter((e) => e.e === 'm').length, downs: downs.length, buttons: downs.map((d) => d.b).join('') };
  // The driver's own log: where it clicked, as fractions of the primary display.
  const driverLog = await untilAsync(() => invoke<string | null>('smoke:realRecording', { op: 'readSignal', name: 'clicks.json' }), 8000);
  let driver: RealCapture['driver'] = null;
  if (driverLog) {
    const clicks = (JSON.parse(driverLog) as { clicks: { fx: number; fy: number; button: string }[] }).clicks;
    let matched = 0;
    let worst = 0;
    for (const c of clicks) {
      const best = downs.filter((d) => d.b === c.button).map((d) => Math.hypot(d.x - c.fx, d.y - c.fy)).sort((a, b) => a - b)[0];
      if (best !== undefined && best < 0.01) matched++;
      worst = Math.max(worst, best ?? 1);
    }
    driver = { clicks: clicks.length, matched, worstOffset: Math.round(worst * 1e4) / 1e4 };
  }
  const shot = await screenshot('gercek-kayit-sonrasi', 500);
  if (shot) shots.push(shot);
  const summary = [
    `arka uç ${rec!.capture.backend}, tıklama yardımcısı ${web?.capabilities.clicks ? 'var' : 'yok'}`,
    screen ? `ekran ${screen.width}×${screen.height}, ${screen.duration.toFixed(2)} sn, ${screen.frames} kare, yayılım ${screen.spread.toFixed(3)}${screen.black ? ' (SİYAH/BOŞ)' : ''}` : 'ekran dosyası yok',
    `kaynak kaydı ${src?.width}×${src?.height} @${src?.fps} fps, ekran ${display!.bounds?.w}×${display!.bounds?.h} ölçek ${display!.scaleFactor ?? 1}`,
    micInfo ? `mikrofon ${micInfo.duration.toFixed(2)} sn, tepe ${micInfo.peak.toFixed(3)}` : 'mikrofon yok',
    `imleç ${cursor.moves} konum, ${cursor.downs} tıklama (${cursor.buttons || '-'})`,
    driver ? `sürücü ${driver.clicks} tıklama, ${driver.matched} eşleşti (en büyük sapma ${driver.worstOffset})` : 'tıklama sürücüsü günlüğü yok',
  ].join(' · ');
  const source = src ? { width: src.width, height: src.height, fps: src.fps, seconds: src.duration / TICKS_PER_SECOND } : null;
  const b = display!.bounds;
  const out: RealCapture = {
    summary, backend: rec!.capture.backend, clicksCapability: !!web?.capabilities.clicks, seconds, screen, source,
    display: b ? { w: b.w, h: b.h, scale: display!.scaleFactor ?? 1 } : null, mic: micInfo, cursor, driver,
  };
  expect(screen, `ekran dosyası yok · ${summary}`);
  expect(Math.abs(screen!.duration - seconds) < 1.5, `ekran videosu ${screen!.duration.toFixed(2)} sn, beklenen ~${seconds} sn · ${summary}`);
  expect(screen!.frames >= seconds * 5, `ekran videosunda ${screen!.frames} kare · ${summary}`);
  expect(!screen!.black, `ekran kaydı siyah ya da tek renk · ${summary}`);
  expect(cursor.moves > 0, `imleç günlüğü boş · ${summary}`);
  if (driver && web?.capabilities.clicks) expect(driver.matched === driver.clicks, `tıklamalar imleç günlüğünde eksik ya da yanlış yerde · ${summary}`);
  return out;
}

/** Uniform dark columns or rows at the frame's edges (letterbox/pillarbox), in pixels of the video. */
interface Bars { left: number; right: number; top: number; bottom: number }
async function sideBars(src: string, at: number): Promise<Bars | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous'; // the media protocol answers with CORS; without it the canvas is tainted
  v.src = src;
  const ok = await new Promise<boolean>((res) => { v.onloadeddata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(false), 8000); });
  if (!ok) return null;
  v.currentTime = at;
  await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 5000); });
  const w = v.videoWidth;
  const h = v.videoHeight;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(v, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  v.removeAttribute('src');
  v.load();
  const dark = (x: number, y: number) => { const i = (y * w + x) * 4; return d[i]! + d[i + 1]! + d[i + 2]! < 24; };
  const col = (x: number) => { for (let y = 0; y < h; y += 4) if (!dark(x, y)) return false; return true; };
  const row = (y: number) => { for (let x = 0; x < w; x += 4) if (!dark(x, y)) return false; return true; };
  let left = 0; while (left < w / 2 && col(left)) left++;
  let right = 0; while (right < w / 2 && col(w - 1 - right)) right++;
  let top = 0; while (top < h / 2 && row(top)) top++;
  let bottom = 0; while (bottom < h / 2 && row(h - 1 - bottom)) bottom++;
  return { left, right, top, bottom };
}

/** Duration of a video whose header has none: seek far past the end, then read it. */
async function durationBySeeking(src: string): Promise<number> {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  await new Promise<void>((res) => { v.onloadedmetadata = () => res(); v.onerror = () => res(); setTimeout(res, 8000); });
  v.currentTime = 1e7;
  await new Promise<void>((res) => { v.ondurationchange = () => { if (Number.isFinite(v.duration)) res(); }; v.onseeked = () => res(); setTimeout(res, 8000); });
  const d = v.duration;
  v.removeAttribute('src');
  v.load();
  return d;
}

/** `until` for a check that has to ask the main process. */
async function untilAsync<T>(fn: () => Promise<T | null | undefined | false>, ms: number): Promise<T | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

/** Frames a video shows when played through once (requestVideoFrameCallback). */
async function countFrames(src: string): Promise<number> {
  const v = document.createElement('video');
  v.muted = true;
  v.src = src;
  let frames = 0;
  const tick = (_n: number, m: VideoFrameCallbackMetadata) => { frames = Math.max(frames, m.presentedFrames); if (!v.ended) v.requestVideoFrameCallback(tick); };
  v.requestVideoFrameCallback(tick);
  await v.play().catch(() => undefined);
  await new Promise<void>((res) => { v.onended = () => res(); v.onerror = () => res(); setTimeout(res, 20_000); });
  v.removeAttribute('src');
  v.load();
  return frames;
}

/**
 * How close a decoded frame of an export is to the picture the editor draws for that moment
 * (renderStill, the export's own compositor): PSNR and mean colour difference (a wrong RGB → YUV
 * conversion shows as a colour shift), and how much fine detail (text edges) it keeps. Both at
 * 960×540; the reference is a JPEG at quality 0.8, so a perfect export does not reach 99 dB.
 */
async function pictureQuality(store: EditorStore, url: string, at: number): Promise<{ psnr: number; meanDiff: [number, number, number]; sharpnessRatio: number; at: number }> {
  const W = 960;
  const H = 540;
  const pixels = async (src: CanvasImageSource): Promise<Uint8ClampedArray> => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(src, 0, 0, W, H);
    return g.getImageData(0, 0, W, H).data;
  };
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous';
  v.src = url;
  await new Promise<void>((res, rej) => { v.onloadeddata = () => res(); v.onerror = () => rej(new Error('video açılmadı')); setTimeout(() => rej(new Error('zaman aşımı')), 8000); });
  v.currentTime = at;
  await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 5000); });
  // The frame on screen starts at a multiple of 1/30 s; the reference is drawn for that moment.
  const shown = Math.floor(v.currentTime * 30 + 1e-6) / 30;
  const decoded = await pixels(v);
  v.removeAttribute('src');
  v.load();
  // A Chromium without a decoder for this file (the package's, without a graphics card) hands out a
  // black frame: that is no measurement of the file.
  let sum = 0;
  for (let i = 0; i < decoded.length; i += 4) sum += decoded[i]! + decoded[i + 1]! + decoded[i + 2]!;
  if (sum / (decoded.length / 4) / 3 < 4 && sharpness(decoded, W, H) === 0) throw new Error('Chromium bu dosyanın karesini çözemedi (siyah kare); dosya sistem sondasıyla denetlendi');
  const s = store.getState();
  const jpeg = await renderStill(store.project, s.cursors, s.mediaBase, secondsToTicks(shown), 'v_16x9', { width: W, height: H });
  const img = new Image();
  img.src = jpeg;
  await img.decode();
  const reference = await pixels(img);
  const { psnr, meanDiff } = compareFrames(decoded, reference);
  const ref = sharpness(reference, W, H);
  return { psnr: Math.round(psnr * 10) / 10, meanDiff: meanDiff.map((x) => Math.round(x * 10) / 10) as [number, number, number], sharpnessRatio: ref ? Math.round((sharpness(decoded, W, H) / ref) * 100) / 100 : 0, at: Math.round(shown * 1000) / 1000 };
}
