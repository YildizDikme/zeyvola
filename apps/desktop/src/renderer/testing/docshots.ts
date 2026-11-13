/**
 * README screenshots (`pnpm docshots`). Opens the sample project (a made-up settings screen,
 * "Örnek Uygulama" / "Deniz Örnek", an abstract camera picture) in the real editor and takes
 * a picture of each main screen. scripts/run-suite.mjs copies `shots` to docs/screenshots/.
 *
 * The run uses the temporary projects folder of the test mode, so the project list holds the
 * sample only. Before each picture the visible text is checked for anything that would give
 * away the machine or its user (a home folder, the projects folder, another project's name).
 */
import { addPrivacy, layoutSegments, timelineToSource } from '@zeyvola/project-model';
import { secondsToTicks } from '@zeyvola/timing';
import { DIST } from '../../shared/distribution';
import { api } from '../api';
import { t } from '../i18n';
import { all, button, click, createSampleProject, currentEditor, invoke, option, q, SAMPLE_PROJECT_NAME, sleep, text, until, type Check } from './harness';

/** File names are fixed: the README links to them. */
export const DOC_SHOTS = ['proje-listesi', 'duzenleyici', 'zoom-secili', 'gizleme-alani', 'dikey-9x16', 'disa-aktarma'] as const;
type ShotName = (typeof DOC_SHOTS)[number];

/** Width of the saved pictures in pixels (the window is 1440 points wide). */
const SHOT_WIDTH = 1600;

export async function runDocShots(): Promise<unknown> {
  const checks: Check[] = [];
  const shots: string[] = [];
  const info = await api.appInfo();
  // Text that must never be on a published picture.
  const forbidden = [info.projectsRoot, '/Users/', '/home/', '/private/', '/var/folders/', 'C:\\Users\\'].filter(Boolean);

  const step = async (name: string, fn: () => Promise<string | void>): Promise<boolean> => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message });
      return false;
    }
  };
  const expect = (cond: unknown, message: string): void => { if (!cond) throw new Error(message); };

  const shoot = async (name: ShotName): Promise<string> => {
    // "Kaydediliyor…" in the top bar would date the picture: wait for the save to finish.
    const open = currentEditor();
    if (open) expect(await until(() => open.store.getState().save === 'saved', 8000), 'proje kaydedilmedi');
    await sleep(900); // transitions, thumbnails and the preview settle
    const visible = document.body.innerText;
    const leak = forbidden.find((f) => visible.includes(f));
    expect(!leak, `görüntüde kişisel olabilecek metin var: ${leak}`);
    const r = await invoke<{ file: string; width: number; height: number } | null>('smoke:shot', { name, width: SHOT_WIDTH });
    expect(r, 'görüntü alınamadı');
    shots.push(r!.file);
    return `${name}.png ${r!.width}×${r!.height}`;
  };

  expect(info.suite === 'docs' && info.smoke, 'belge görüntüleri yalnızca --docshots kipinde çalışır');
  await step('Test kipi geçici proje klasörünü kullanıyor', async () => {
    expect(/zeyvola-smoke-/.test(info.projectsRoot), 'proje klasörü geçici klasör değil');
  });

  const sample = await createSampleProject(8, SAMPLE_PROJECT_NAME);

  // The list shows a thumbnail once the editor has saved one, so the project is opened first.
  const ready = await step('Örnek proje açıldı, otomatik zoom önerileri oluştu', async () => {
    click(button(t("Yenile")), 'Yenile düğmesi');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === SAMPLE_PROJECT_NAME), 8000);
    expect(card, 'örnek proje listede yok');
    click(q('.project-thumb', card!), 'proje kartı');
    const ed = await until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
    expect(ed, 'düzenleyici açılmadı');
    expect(await until(() => ed!.store.project.zooms.length > 0, 12_000), 'öneri oluşmadı');
    expect(await until(() => ed!.store.getState().save === 'saved', 8000), 'proje kaydedilmedi');
    return `${ed!.store.project.zooms.length} öneri`;
  });
  if (!ready) return { suite: 'docs', ok: false, checks, shots, dist: DIST };

  await step('Proje listesi: yalnızca örnek proje, küçük resmiyle', async () => {
    click(button(t("Projelere dön")), 'Projelere dön');
    const card = await until(() => all('.project-card').find((c) => text(q('.project-meta strong', c)) === SAMPLE_PROJECT_NAME && q('.project-thumb img', c)), 10_000);
    expect(card, 'örnek proje küçük resmiyle listede yok');
    const names = all('.project-card').map((c) => text(q('.project-meta strong', c)));
    expect(names.length === 1, `listede ${names.length} proje var: ${names.join(', ')}`);
    return shoot('proje-listesi');
  });

  const ed = await (async () => {
    const card = all('.project-card').find((c) => text(q('.project-meta strong', c)) === SAMPLE_PROJECT_NAME);
    if (card) click(q('.project-thumb', card), 'proje kartı');
    return until(() => (q('.editor') ? currentEditor(sample.id) : null), 10_000);
  })();
  if (!ed) {
    checks.push({ name: 'Düzenleyici yeniden açıldı', ok: false });
    return { suite: 'docs', ok: false, checks, shots, dist: DIST };
  }
  const { store } = ed;
  const zooms = () => [...store.project.zooms].sort((a, b) => a.start - b.start);
  // The middle of the first zoom: the preview shows it at full strength.
  const insideZoom = () => { const z = zooms()[0]!; return z.start + Math.round((z.end - z.start) / 2); };

  await step('Düzenleyici: zoom önerileri zaman çizelgesinde', async () => {
    store.select(null);
    store.setPlayhead(insideZoom());
    expect(await until(() => all('.tl-item.tl-zoom').length === store.project.zooms.length, 3000), 'zoom\'lar çizelgede görünmüyor');
    return shoot('duzenleyici');
  });

  await step('Zoom seçili: ayarları sağ panelde', async () => {
    const el = all('.tl-item.tl-zoom')[0] ?? null;
    click(el, 'zaman çizelgesindeki ilk zoom');
    expect(await until(() => store.getState().selection?.kind === 'zoom', 3000), 'zoom seçilmedi');
    store.setPlayhead(insideZoom());
    return shoot('zoom-secili');
  });

  await step('Gizleme alanı: telefon numarası buzlu camla kapalı', async () => {
    const rec = sample.recording!;
    const at = secondsToTicks(3);
    const pos = timelineToSource(store.project, at, layoutSegments(store.project));
    expect(pos, 'zaman çizelgesinde 3. saniye yok');
    let id = '';
    store.apply((p) => {
      const r = addPrivacy(p, {
        recordingId: pos!.recordingId, start: at, end: secondsToTicks(5.5), origin: 'manual',
        region: rec.secretRegion, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
      });
      id = r.id;
      return r.project;
    });
    store.select({ kind: 'privacy', id });
    store.setPlayhead(secondsToTicks(3.8));
    expect(await until(() => q('.tl-item.tl-privacy') && store.getState().selection?.kind === 'privacy', 3000), 'gizleme alanı çizelgede ya da seçili değil');
    return shoot('gizleme-alani');
  });

  await step('Dikey format (9:16)', async () => {
    store.select(null);
    click(option(t("Video formatı"), '9:16'), '9:16 formatı');
    expect(await until(() => store.project.activeVariantId === 'v_9x16', 3000), '9:16 seçilmedi');
    store.setPlayhead(secondsToTicks(1.2));
    const detail = await shoot('dikey-9x16');
    click(option(t("Video formatı"), '16:9'), '16:9 formatı');
    expect(await until(() => store.project.activeVariantId === 'v_16x9', 3000), '16:9\'a dönülmedi');
    return detail;
  });

  await step('Dışa aktarma penceresi', async () => {
    store.setPlayhead(insideZoom());
    click(button(t("Dışa aktar"), q('.topbar-right')!), 'üst çubuktaki Dışa aktar');
    const dialog = await until(() => q('.export-modal'), 3000);
    expect(dialog, 'dışa aktarma penceresi açılmadı');
    // The privacy check pictures are drawn in the background.
    expect(await until(() => all('.privacy-check figure').length > 0 && all('.privacy-check .thumb-wait').length === 0, 10_000), 'gizleme kontrol kareleri çizilmedi');
    const detail = await shoot('disa-aktarma');
    click(button(t("Kapat"), dialog!), 'pencereyi kapat');
    return detail;
  });

  const ok = checks.every((c) => c.ok) && shots.length === DOC_SHOTS.length;
  return { suite: 'docs', ok, checks, shots, dist: DIST };
}
