import {
  DEFAULT_MAGNIFIER_DURATION, laneRange, layoutSegments, newCameraMoveLayout, placeItem, presetTransition, timelineToSource, type ID, type NewCameraLayout, type NewMagnifier, type NewPrivacy, type NewZoom, type TrackKey,
} from '@zeyvola/project-model';
import type { Ticks } from '@zeyvola/timing';
import type { EditorStore, SelectionKind } from '../../state/editor-store';
import { t } from '../../i18n';

const KIND: Record<TrackKey, SelectionKind> = { zooms: 'zoom', privacy: 'privacy', cameraLayouts: 'camera', magnifiers: 'magnifier' };

type NewByKey = { zooms: NewZoom; cameraLayouts: NewCameraLayout; privacy: NewPrivacy; magnifiers: NewMagnifier };

/** Adds an item through the placement rules and tells the user when it is refused. */
export function place<K extends TrackKey>(store: EditorStore, key: K, item: NewByKey[K]): boolean {
  const r = placeItem(store.project, key, item);
  if (!r.ok) {
    store.select({ kind: KIND[key], id: r.conflict.id });
    store.notify(key === 'privacy'
      ? t("Bu alan bu zamanda zaten gizleniyor. Mevcut alanı seçtim; düzenleyebilir veya başka bir yere çizebilirsiniz.")
      : key === 'zooms'
        ? t("Burada zaten bir zoom var. Öğeler üst üste eklenemez; mevcut olanı seçtim.")
        : key === 'magnifiers'
          ? t("Burada zaten bir büyüteç aralığı var. Öğeler üst üste eklenemez; mevcut olanı seçtim.")
          : t("Burada zaten bir kamera hareketi var. Öğeler üst üste eklenemez; mevcut olanı seçtim."));
    return false;
  }
  store.apply(() => r.project);
  store.select({ kind: KIND[key], id: r.id });
  if (r.replacedSuggestions > 0) store.notify(t("Bu aralıktaki otomatik zoom önerisinin yerine sizin zoom'unuz konuldu."));
  else if (r.trimmed) {
    store.notify(key === 'zooms' ? t("Yeni zoom sonraki öğeye çarpmasın diye kısaltıldı.") : key === 'privacy' ? t("Yeni gizleme alanı sonraki öğeye çarpmasın diye kısaltıldı.")
      : key === 'magnifiers' ? t("Yeni büyüteç aralığı sonraki öğeye çarpmasın diye kısaltıldı.") : t("Yeni kamera hareketi sonraki öğeye çarpmasın diye kısaltıldı."));
  }
  return true;
}

/** Where a privacy area added from the timeline starts; the user then moves it on the preview. */
export const DEFAULT_PRIVACY_REGION = { x: 0.4, y: 0.42, w: 0.2, h: 0.08 };

/** Adds a zoom, camera move, privacy area or magnifier range over a source range picked on the timeline (or at the playhead). */
export function placeRange(store: EditorStore, key: TrackKey, r: { recordingId: ID; start: Ticks; end: Ticks }): boolean {
  const p = store.project;
  if (key === 'privacy') {
    return place(store, 'privacy', {
      ...r, origin: 'manual', region: DEFAULT_PRIVACY_REGION, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
    });
  }
  if (key === 'cameraLayouts') {
    const ok = place(store, 'cameraLayouts', { ...r, origin: 'manual', layout: newCameraMoveLayout(p), enter: presetTransition('smooth') });
    if (ok) store.notify(t("Kamera hareketi eklendi. Şimdi önizlemede 2. konumu seçin."));
    return ok;
  }
  if (key === 'magnifiers') {
    const m = p.style.magnifier;
    return place(store, 'magnifiers', { ...r, origin: 'manual', size: m.size, zoom: m.zoom });
  }
  const d = p.style.zoomDefaults;
  return place(store, 'zooms', { ...r, origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.5 }, scale: d.scale, enter: d.enter, exit: d.exit });
}

/**
 * Adds a magnifier range at timeline time `at` (3 s, shortened to fit before the next one), or
 * selects the range already there.
 */
export function addMagnifierAt(store: EditorStore, at: Ticks): boolean {
  const p = store.project;
  const pos = timelineToSource(p, at, layoutSegments(p));
  if (!pos) return false;
  const here = p.magnifiers.find((m) => m.recordingId === pos.recordingId && m.start <= pos.sourceTime && pos.sourceTime < m.end);
  if (here) { store.select({ kind: 'magnifier', id: here.id }); return false; }
  const r = laneRange(p, 'magnifiers', at, at + DEFAULT_MAGNIFIER_DURATION);
  if (!r) { store.notify(t("Burada yeni büyüteç aralığına yer yok.")); return false; }
  return placeRange(store, 'magnifiers', r);
}
