/**
 * Interface test (`pnpm uitest`): the main flow, driven through the interface the way a person
 * uses it — buttons are found by their visible text or accessible name and clicked.
 *
 *   project list → open the project → edit (zoom tool, undo/redo, split, play) →
 *   automatic zoom (clear, generate) → export (finish one, pick another folder, cancel one) →
 *   back to the list
 *
 * Every exported MP4 is also opened with macOS's own decoders (AVFoundation, tests/media-check),
 * the way QuickTime sees it: Chromium plays VP9-in-MP4 happily, QuickTime shows no picture.
 *
 * The editor's state is only read, to check what each click did. `pnpm smoke` stays the test of
 * the parts (compositor, privacy, codecs, timeline gestures); this one checks that the parts
 * work together from the first screen to the exported file.
 */
import { sequenceDuration } from '@zeyvola/project-model';
import { TICKS_PER_SECOND } from '@zeyvola/timing';
import { Mp4Writer } from '@zeyvola/media-web';
import { PROFILE, DIST } from '../../shared/distribution';
import { t } from '../i18n';
import { recordLikeBrowser } from '../smoke-fixtures';
import {
  all, button, click, createSampleProject, currentEditor, decodeSound, frame, invoke, key, mediaUrl, Missing, option, peak, pressAt, probeVideo, q, screenshot, sleep, text, until, type Check,
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

  await step('İlk açılış: otomatik zoom önerileri zaman çizelgesinde görünür', async () => {
    expect(await until(() => autoZooms() > 0, 12_000), 'öneri oluşmadı');
    expect(await until(() => all('.tl-item.tl-zoom.is-auto').length === autoZooms(), 3000), `çizelgede ${all('.tl-item.tl-zoom.is-auto').length}, projede ${autoZooms()} öneri`);
    await until(() => store.getState().save === 'saved', 5000);
    return `${autoZooms()} öneri`;
  });

  await step('Düzenleme: zoom aracıyla önizlemeye basınca elle zoom eklenir; geri al ve yinele çalışır', async () => {
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

  await step('Düzenleme: oynat düğmesi önizlemeyi oynatır, zaman göstergesi ilerler, duraklat durdurur', async () => {
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

  await step('Düzenleme: S tuşu klibi oynatma imlecinden böler, geri al birleştirir', async () => {
    const before = store.project.sequence.segments.length;
    key('s');
    expect(await until(() => store.project.sequence.segments.length === before + 1, 2000), 'klip bölünmedi');
    expect(await until(() => all('.tl-seg.tl-seg-screen').length === before + 1, 3000), 'bölünen klip çizelgede görünmüyor');
    key('z', { metaKey: true });
    expect(await until(() => store.project.sequence.segments.length === before, 2000), 'geri al bölmeyi kaldırmadı');
  });

  await step('Otomatik zoom: Zoom sekmesinde "Önerileri temizle" ve "Önerileri oluştur" çalışır, elle zoom\'a dokunmaz', async () => {
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
  const ext = PROFILE.defaultExport;
  const exportedUrl = (n = 1) => mediaUrl(fileBase(), `exports/Arayüz testi 16x9${n > 1 ? ` (${n})` : ''}.${ext}`);
  /** macOS's own decoders on an MP4 (WebM is not a QuickTime format; Chromium checks those). */
  const systemCheck = async (path: string): Promise<string> => {
    if (ext !== 'mp4') return 'WebM: sistem sondası yok';
    const r = await invoke<AvCheck>('smoke:avCheck', { path, duration: expected() });
    if (r.skipped) return 'sistem sondası yalnızca macOS';
    expect(r.ok, `AVFoundation: ${r.problems.join('; ')}`);
    return `AVFoundation: ${r.video?.codec} ${r.video?.decodedFrames} kare çözüldü, ${r.audio?.codec.trim()} ${r.audio?.decodedSeconds?.toFixed(2)} sn`;
  };
  const donePath = (): string => q('.export-done span')?.getAttribute('title') ?? '';

  await step(`Dışa aktarma: pencereden ${ext.toUpperCase()} 1080p30 dosyası alınır ve oynatılabilir`, async () => {
    await until(() => store.getState().save === 'saved', 5000);
    click(button(t("Dışa aktar"), q('.topbar-right')!), 'üst çubuktaki Dışa aktar');
    const dialog = await until(() => q('.export-modal'), 3000);
    expect(dialog, 'dışa aktarma penceresi açılmadı');
    click(option(t("Kare hızı"), t("30 fps"), dialog!), '30 fps');
    await frame();
    click(button(t("Dışa aktar"), q('.export-modal footer')!), 'penceredeki Dışa aktar');
    expect(await until(() => q('.export-progress .bar') || q('.export-done') || q('.export-progress .is-error'), 10_000, 20), 'ilerleme çubuğu görünmedi');
    const end = await until(() => q('.export-done') ?? q('.export-progress .is-error'), 150_000, 50);
    expect(end, 'dışa aktarma 150 sn içinde bitmedi');
    expect(end!.classList.contains('export-done'), `hata: ${text(end)}`);
    expect(button(t("Klasörde göster"), dialog!), '"Klasörde göster" düğmesi yok');
    const file = await probeVideo(exportedUrl(), expected() / 2);
    expect(file.ok, 'dışa aktarılan dosya açılamadı');
    // Never shorter than the timeline by more than one frame (1/30 s). Longer by at most 0.12 s:
    // the Opus encoder pads the last packets and the writers do not trim that tail (about 0.09 s
    // measured), so the file reads a little longer than the picture.
    const diff = file.duration - expected();
    expect(diff > -1 / 30 && diff < 0.12, `dosya ${file.duration.toFixed(3)} sn, zaman çizelgesi ${expected().toFixed(3)} sn`);
    expect(file.width === 1920 && file.height === 1080, `boyut ${file.width}×${file.height}`);
    expect(file.spread > 0.02, `ortadaki kare tek renk (parlaklık yayılımı ${file.spread.toFixed(3)})`);
    const sound = await decodeSound(exportedUrl()).catch((e: Error) => { throw new Error(`ses çözülemedi: ${e.message}`); });
    expect(sound.duration > expected() - 0.05 && sound.duration < expected() + 0.12, `ses ${sound.duration.toFixed(2)} sn, zaman çizelgesi ${expected().toFixed(2)} sn`);
    expect(peak(sound) > 0.01, `ses sessiz (tepe ${peak(sound).toFixed(4)})`);
    const done = text(q('.export-done span'));
    expect(/MB/.test(done), `bitiş satırında dosya boyutu yok: "${done}"`);
    expect(donePath().endsWith(`/exports/Arayüz testi 16x9.${ext}`), `dosya yolu: "${donePath()}"`);
    const system = await systemCheck(donePath());
    const shot = await screenshot('disa-aktarma-bitti', 200);
    if (shot) shots.push(shot);
    return `${done}, ${file.duration.toFixed(2)} sn (çizelge ${expected().toFixed(2)}), ${file.width}×${file.height}, ses ${sound.duration.toFixed(2)} sn · ${system}`;
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
    if (chosenFolder) {
      const files = await invoke<string[]>('smoke:listDir', { path: chosenFolder });
      expect(files.length === 1 && files[0] === `Arayüz testi 16x9.${ext}`, `iptalden sonra seçilen klasörde: ${files.join(', ')}`);
    }
    expect(button(t("Dışa aktar"), q('.export-modal footer')!), 'iptalden sonra Dışa aktar düğmesi yok');
    click(button(t("Kapat"), dialog!), 'pencereyi kapat');
    expect(await until(() => !q('.export-modal'), 2000), 'pencere kapanmadı');
  });

  await step('Projelere dön: değişiklikler kaydedilir, proje listede küçük resmiyle durur', async () => {
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

  await step('Sistem sondası kendini kanıtlar: eski sürümün VP9 + Opus\'lu MP4\'ünde "görüntü çözülemiyor" der', async () => {
    if (ext !== 'mp4') return 'WebM dağıtımı: atlandı';
    // What the published build wrote as "MP4" until 2026-11-13 (vp09 + Opus boxes).
    await invoke('smoke:writeFile', { projectId: sample.id, path: 'exports/eski-vp9.mp4', data: await oldStyleMp4() });
    const r = await invoke<AvCheck>('smoke:avCheck', { projectId: sample.id, path: 'exports/eski-vp9.mp4' });
    if (r.skipped) return 'yalnızca macOS';
    expect(!r.ok, 'sonda VP9\'lu MP4\'ü kabul etti');
    expect(r.problems.some((p) => p.startsWith('görüntü çözülemiyor')), `sorunlar: ${r.problems.join('; ')}`);
    expect(r.problems.some((p) => p.startsWith('ses AAC değil')), `sorunlar: ${r.problems.join('; ')}`);
    return r.problems.join('; ');
  });

  return { suite: 'ui', ok: checks.every((c) => c.ok), checks, shots, dist: DIST };
}

interface AvCheck {
  ok: boolean;
  skipped?: boolean;
  problems: string[];
  video: { codec: string; decodedFrames: number } | null;
  audio: { codec: string; decodedSeconds?: number } | null;
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
