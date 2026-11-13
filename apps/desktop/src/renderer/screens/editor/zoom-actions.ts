import { applyZoomSuggestions, clearAutoZooms, parseCursorLog, type Project } from '@zeyvola/project-model';
import { ENGINE_VERSION, combineNoSuggestionReasons, suggestZooms, whyNoSuggestions, type NoSuggestionReason } from '@zeyvola/zoom-engine';
import type { EditorStore } from '../../state/editor-store';
import { t } from '../../i18n';

export interface ZoomRun {
  /** Suggestions made. */
  count: number;
  /** Why there are none, when there are none. */
  reason: NoSuggestionReason | null;
}

/** Runs the zoom engine for every recording that has a cursor log. Returns the number of suggestions. */
export async function regenerateZoomSuggestions(store: EditorStore): Promise<number> {
  return (await runZoomSuggestions(store)).count;
}

/** Runs the zoom engine for every recording that has a cursor log, and says why if nothing came out. */
export async function runZoomSuggestions(store: EditorStore): Promise<ZoomRun> {
  const project = store.project;
  const results: { recordingId: string; items: ReturnType<typeof suggestZooms> }[] = [];
  const reasons: NoSuggestionReason[] = [];
  for (const rec of Object.values(project.recordings)) {
    const text = await store.rawCursorText(rec.id);
    if (!text) { reasons.push('no-cursor'); continue; }
    const track = parseCursorLog(text);
    const items = suggestZooms({
      recordingId: rec.id,
      duration: rec.duration,
      track,
      hasClicks: rec.capture.hasClicks,
      markers: rec.markers,
      sensitivity: project.zoomEngine.sensitivity,
      defaults: project.style.zoomDefaults,
    });
    results.push({ recordingId: rec.id, items });
    if (items.length === 0) reasons.push(whyNoSuggestions(track, rec.capture.hasClicks));
  }
  let count = 0;
  store.apply((p: Project) => {
    let next = p;
    for (const r of results) {
      next = applyZoomSuggestions(next, r.recordingId, r.items);
      count += r.items.length;
    }
    return { ...next, zoomEngine: { ...next.zoomEngine, engineVersion: ENGINE_VERSION } };
  });
  return { count, reason: count > 0 ? null : combineNoSuggestionReasons(reasons) };
}

/** What to tell the user when a run made no suggestions. */
export function noSuggestionMessage(reason: NoSuggestionReason): string {
  switch (reason) {
    case 'outside': return t("Öneri çıkmadı: imleç kaydın neredeyse tamamında kaydedilen ekranın dışındaydı. Büyük olasılıkla çalıştığınız ekran değil başka bir ekran kaydedildi. Zoom'ları elle ekleyebilirsiniz.");
    case 'no-cursor': return t("Öneri çıkmadı: bu kayıtta imleç verisi yok.");
    case 'no-clicks': return t("Öneri çıkmadı: kayıtta tıklama verisi yok ve imleç hiçbir noktada yeterince durmadı.");
    case 'quiet': return t("Öneri çıkmadı: imleç hareketlerinde zoom'a uygun bir an bulunamadı. Hassasiyeti \"Çok\" yapıp yeniden deneyin.");
  }
}

export function clearZoomSuggestions(store: EditorStore): void {
  store.apply((p) => {
    let next = p;
    for (const id of Object.keys(p.recordings)) next = clearAutoZooms(next, id);
    return next;
  });
}
