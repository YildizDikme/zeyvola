import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CAMERA_MOVE, activeVariant, laneRange, layoutSegments, removeCameraLayout, removeMagnifier, removePrivacy, removeSegment,
  removeZoom, renameProject, resolveOverlaps, sequenceDuration, setActiveVariant, splitAt, timelineToSource,
} from '@zeyvola/project-model';
import type { OpenedProject } from '@zeyvola/protocol';
import { formatTimecode, frameDuration, secondsToTicks } from '@zeyvola/timing';
import { api } from '../../api';
import { renderStill } from '../../export/exporter';
import { Player } from '../../playback/player';
import { EditorStore, useEditor, type Tool } from '../../state/editor-store';
import { Button, EditableText, IconButton, Kbd, Segmented } from '../../ui/controls';
import { Icon } from '../../ui/icons';
import { keyLabel, RECORDING_KEYS, redoLabel } from '../../ui/keys';
import { Settings } from '../Settings';
import { ExportDialog } from './ExportDialog';
import { Inspector } from './Inspector';
import { addMagnifierAt, place, placeRange } from './placement';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { noSuggestionMessage, runZoomSuggestions } from './zoom-actions';
import { t } from '../../i18n';
import { probe } from '../../perf-probe';

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function Editor({ opened, onBack, notice: initialNotice, onNoticeShown }: {
  opened: OpenedProject; onBack: () => void;
  /** Shown once when the editor opens (for example a recording recovered after a crash). */
  notice?: string; onNoticeShown?: () => void;
}) {
  probe.count('react:Editor');
  const store = useMemo(() => new EditorStore(opened), [opened]);
  const player = useMemo(() => new Player(store), [store]);
  const project = useEditor(store, (s) => s.project);
  // Redrawn when the playhead comes to rest, not on every frame of playback (see Timecode below).
  const playhead = useEditor(store, (s) => s.settledPlayhead);
  const playing = useEditor(store, (s) => s.playing);
  const tool = useEditor(store, (s) => s.tool);
  const selection = useEditor(store, (s) => s.selection);
  const save = useEditor(store, (s) => s.save);
  const canUndo = useEditor(store, (s) => s.canUndo);
  const canRedo = useEditor(store, (s) => s.canRedo);
  const exportOpen = useEditor(store, (s) => s.exportOpen);
  const notice = useEditor(store, (s) => s.notice);
  const [help, setHelp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(false);
  settingsRef.current = settingsOpen;
  const duration = sequenceDuration(project);
  if (document.documentElement.dataset.smoke === '1') (window as unknown as { __zeyvolaEditor?: unknown }).__zeyvolaEditor = { store, player };

  // React's development check unmounts and mounts every effect once more with the same
  // store and player; the player is closed only if it is not mounted again right away.
  const closing = useRef<{ player: Player; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    if (closing.current?.player === player) { clearTimeout(closing.current.timer); closing.current = null; }
    void (async () => {
      // Older projects may contain stacked items; repair them once (undoable).
      if (resolveOverlaps(store.project) !== store.project) {
        store.apply(resolveOverlaps);
        store.notify(t("Üst üste binen öğeler düzeltildi. Geri almak için {key}.", { key: keyLabel('mod+Z') }));
      }
      await store.loadCursors();
      // First open of a fresh recording: generate zoom suggestions once.
      const p = store.project;
      if (!p.zoomEngine.engineVersion && p.zooms.length === 0 && Object.keys(p.recordings).length > 0) {
        const run = await runZoomSuggestions(store);
        // Said once on the first open; a notice already on screen (e.g. a recovered recording) stays.
        if (run.reason && !store.getState().notice) store.notify(noSuggestionMessage(run.reason), 12_000);
        // The browser delivered the screen squeezed; it is shown with the display's real shape.
        if (Object.values(p.recordings).some((r) => r.sources.screen?.displayAspect) && !store.getState().notice) {
          store.notify(t("Ekran görüntüsü kayıtta basık geldi; ekranın gerçek oranıyla gösteriliyor. Bir yönde ayrıntı biraz az olabilir."), 12_000);
        }
      }
      await saveThumbnail(store);
    })();
    return () => {
      void store.flush();
      closing.current = { player, timer: setTimeout(() => player.dispose(), 0) };
    };
  }, [store, player]);

  useEffect(() => {
    if (!initialNotice) return;
    store.notify(initialNotice, 12_000);
    onNoticeShown?.();
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (settingsRef.current) {
        if (e.key === 'Escape') setSettingsOpen(false);
        return;
      }
      if (mod && e.key === ',') { e.preventDefault(); setSettingsOpen(true); return; }
      const s = store.getState();
      const fd = frameDuration(s.project.sequence.fps);
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo(); else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
      if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); store.setExportOpen(true); return; }
      if (mod) return;
      switch (e.key) {
        case ' ': e.preventDefault(); player.toggle(); break;
        case 'ArrowLeft': e.preventDefault(); if (s.playing) player.pause(); store.setPlayhead(s.playhead - (e.shiftKey ? secondsToTicks(1) : fd)); break;
        case 'ArrowRight': e.preventDefault(); if (s.playing) player.pause(); store.setPlayhead(s.playhead + (e.shiftKey ? secondsToTicks(1) : fd)); break;
        case 'Home': store.setPlayhead(0); break;
        case 'End': store.setPlayhead(sequenceDuration(s.project)); break;
        case 's': case 'S': store.apply((p) => splitAt(p, s.playhead)); break;
        case 'c': case 'C': store.setTool(s.tool === 'cut' ? 'select' : 'cut'); break;
        case 'k': case 'K': store.setTool(s.tool === 'camera' ? 'select' : 'camera'); break;
        case 'z': case 'Z': store.setTool(s.tool === 'zoom' ? 'select' : 'zoom'); break;
        case 'b': case 'B': store.setTool(s.tool === 'privacy' ? 'select' : 'privacy'); break;
        case 'm': case 'M': store.setTool(s.tool === 'magnifier' ? 'select' : 'magnifier'); break;
        case 'v': case 'V': case 'Escape': store.setTool('select'); if (e.key === 'Escape') store.select(null); break;
        case '?': setHelp((h) => !h); break;
        case 'Delete': case 'Backspace': {
          const sel = s.selection;
          if (!sel) break;
          e.preventDefault();
          if (sel.kind === 'zoom') store.apply((p) => removeZoom(p, sel.id));
          if (sel.kind === 'privacy') store.apply((p) => removePrivacy(p, sel.id));
          if (sel.kind === 'camera') store.apply((p) => removeCameraLayout(p, sel.id));
          if (sel.kind === 'magnifier') store.apply((p) => removeMagnifier(p, sel.id));
          if (sel.kind === 'segment' && s.project.sequence.segments.length > 1) store.apply((p) => removeSegment(p, sel.id));
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, player]);

  const addPrivacyHere = () => {
    const pos = timelineToSource(project, store.getState().playhead, layoutSegments(project));
    if (!pos) return;
    place(store, 'privacy', {
      recordingId: pos.recordingId, start: pos.sourceTime, end: Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3)),
      origin: 'manual', region: { x: 0.4, y: 0.42, w: 0.2, h: 0.08 }, keyframes: [], effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
    });
  };
  const hasCamera = Object.values(project.recordings).some((r) => r.sources.camera);

  // Camera move being edited (selected, else under the playhead) — drives the tool hint.
  const editMove = (() => {
    const sel = selection?.kind === 'camera' ? project.cameraLayouts.find((c) => c.id === selection.id) : undefined;
    if (sel) return sel;
    const pos = timelineToSource(project, playhead, layoutSegments(project));
    return pos ? project.cameraLayouts.find((c) => c.recordingId === pos.recordingId && c.start <= pos.sourceTime && pos.sourceTime < c.end) : undefined;
  })();

  // With the camera tool on, moving the playhead out of the selected move ends its editing,
  // so the next press on the preview adds a new move at the new place.
  const lastPlayhead = useRef(playhead);
  useEffect(() => {
    if (lastPlayhead.current === playhead) return;
    lastPlayhead.current = playhead;
    const s = store.getState();
    if (s.tool !== 'camera' || s.selection?.kind !== 'camera') return;
    const item = s.project.cameraLayouts.find((c) => c.id === s.selection!.id);
    const pos = timelineToSource(s.project, playhead, layoutSegments(s.project));
    if (item && !(pos && pos.recordingId === item.recordingId && pos.sourceTime >= item.start && pos.sourceTime < item.end)) store.select(null);
  }, [playhead, store]);
  /** Adds a camera move at the playhead (3 s, shortened to fit) and turns on the camera tool. */
  const addCameraHere = () => {
    const at = store.getState().playhead;
    const r = laneRange(project, 'cameraLayouts', at, at + DEFAULT_CAMERA_MOVE);
    if (!r) {
      const covering = timelineToSource(project, at, layoutSegments(project));
      const hit = covering && project.cameraLayouts.find((c) => c.recordingId === covering.recordingId && c.start <= covering.sourceTime && covering.sourceTime < c.end);
      if (hit) store.select({ kind: 'camera', id: hit.id });
      store.notify(hit ? t("Burada zaten bir kamera hareketi var. Öğeler üst üste eklenemez; mevcut olanı seçtim.") : t("Burada yeni kamera hareketine yer yok."));
      store.setTool('camera');
      return;
    }
    if (placeRange(store, 'cameraLayouts', r)) store.setTool('camera');
  };
  const addZoomHere = () => {
    const pos = timelineToSource(project, store.getState().playhead, layoutSegments(project));
    if (!pos) return;
    const d = project.style.zoomDefaults;
    place(store, 'zooms', {
      recordingId: pos.recordingId, start: pos.sourceTime, end: Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3)),
      origin: 'manual', mode: 'region', center: { x: 0.5, y: 0.5 }, scale: d.scale, enter: d.enter, exit: d.exit,
    });
  };

  const variant = activeVariant(project);
  const saveLabel = save === 'saved' ? t("Kaydedildi") : save === 'error' ? t("Kaydedilemedi") : t("Kaydediliyor…");

  return (
    <div className="editor">
      <header className="topbar drag">
        <div className="topbar-left no-drag">
          <IconButton icon="back" label={t("Projelere dön")} onClick={async () => { await store.flush(); onBack(); }} />
          <EditableText value={project.name} className="project-title" onCommit={(name) => store.apply((p) => renameProject(p, name))} />
          <span className={`save-state is-${save}`}><span className="save-dot" />{saveLabel}</span>
        </div>
        <div className="topbar-center no-drag">
          <Segmented<string> label={t("Video formatı")} value={project.activeVariantId}
            options={project.variants.map((v) => ({ value: v.id, label: v.name }))}
            onChange={(id) => store.apply((p) => setActiveVariant(p, id))} />
        </div>
        <div className="topbar-right no-drag">
          <IconButton icon="undo" label={t("Geri al ({key})", { key: keyLabel('mod+Z') })} onClick={() => store.undo()} disabled={!canUndo} />
          <IconButton icon="redo" label={t("Yinele ({key})", { key: redoLabel() })} onClick={() => store.redo()} disabled={!canRedo} />
          <IconButton icon="info" label={t("Kısayollar (?)")} onClick={() => setHelp(!help)} active={help} />
          <IconButton icon="sliders" label={t("Ayarlar ({key})", { key: keyLabel('mod+,') })} onClick={() => setSettingsOpen(true)} active={settingsOpen} />
          <Button variant="primary" icon="export" onClick={() => store.setExportOpen(true)} disabled={duration === 0}>{t("Dışa aktar")}</Button>
        </div>
      </header>
      <div className="editor-main">
        <div className="stage">
          <Preview store={store} player={player} />
          <div className="stage-toolbar">
            <Segmented<Tool> size="sm" label={t("Araç")} value={tool} onChange={(t) => store.setTool(t)}
              options={[
                { value: 'select', label: t("Seç"), icon: 'cursor' },
                { value: 'zoom', label: t("Zoom"), icon: 'zoom' },
                { value: 'magnifier', label: t("Büyüteç"), icon: 'magnifier' },
                { value: 'camera', label: t("Dinamik kamera"), icon: 'camera' },
                { value: 'privacy', label: t("Gizle"), icon: 'privacy' },
                { value: 'cut', label: t("Kes"), icon: 'scissors' },
              ]} />
            {tool === 'privacy' && <span className="tool-hint">{t("Gizlenecek alanı önizlemede çizin ya da zaman çizelgesinde istediğiniz ana basın: oraya 3 sn'lik gizleme alanı eklenir.")}</span>}
            {tool === 'zoom' && <span className="tool-hint">{t("Zaman çizelgesinde istediğiniz ana ya da önizlemede yakınlaşılacak noktaya basın: 3 sn'lik zoom eklenir. Sürükleyerek daha uzun çizebilirsiniz.")}</span>}
            {tool === 'camera' && <span className="tool-hint">{!editMove
              ? t("Zaman çizelgesinde bir ana basın ya da önizlemede kamerayı gideceği yere sürükleyin: kamera hareketi eklenir.")
              : !editMove.second
                ? t("2. konumu seçin: önizlemede kameranın gideceği yere tıklayın.")
                : t("1 ve 2 numaralı çerçeveleri sürükleyerek konumları değiştirin. Zaman çizelgesindeki çizgi, kameranın 2. konuma geçtiği an.")}</span>}
            {tool === 'magnifier' && <span className="tool-hint">{t("Zaman çizelgesinde istediğiniz ana ya da önizlemeye basın: 3 sn'lik büyüteç aralığı eklenir. Sürükleyerek daha uzun çizebilirsiniz.")}</span>}
            {tool === 'cut' && <span className="tool-hint">{t("Zaman çizelgesinde kesmek istediğiniz yere tıklayın · bitirmek için Seç veya Esc")}</span>}
          </div>
          {help && <ShortcutHelp onClose={() => setHelp(false)} />}
          {notice && <div className="toast" role="status"><Icon name="info" size={15} />{notice}</div>}
        </div>
        <Inspector store={store} player={player} />
      </div>
      <div className="transport">
        <div className="transport-left">
          <IconButton icon="scissors" label={tool === 'cut' ? t("Kesme modunu kapat (C)") : t("Kesme modu: fareyle kes (C)")} active={tool === 'cut'} onClick={() => store.setTool(tool === 'cut' ? 'select' : 'cut')} />
          <IconButton icon="zoom" label={t("Buraya zoom ekle")} onClick={addZoomHere} />
          <IconButton icon="magnifier" label={t("Buraya büyüteç ekle")} onClick={() => addMagnifierAt(store, store.getState().playhead)} />
          {hasCamera && <IconButton icon="camera" label={t("Buraya dinamik kamera ekle")} onClick={addCameraHere} />}
          <IconButton icon="privacy" label={t("Buraya gizleme alanı ekle")} onClick={addPrivacyHere} />
        </div>
        <div className="transport-center">
          <IconButton icon="back" label={t("Bir kare geri (←)")} onClick={() => store.setPlayhead(store.getState().playhead - frameDuration(project.sequence.fps))} />
          <button type="button" className="play-btn" onClick={() => player.toggle()} aria-label={playing ? t("Duraklat") : t("Oynat")} title={t("Oynat / duraklat (boşluk)")}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <IconButton icon="chevronRight" label={t("Bir kare ileri (→)")} onClick={() => store.setPlayhead(store.getState().playhead + frameDuration(project.sequence.fps))} />
          <Timecode store={store} />
        </div>
        <div className="transport-right">
          <span className="muted small">{variant.width}×{variant.height} · {project.sequence.fps.num / project.sequence.fps.den} fps</span>
          <IconButton icon="zoom" label={t("Zaman çizelgesini yakınlaştır ({key} + kaydırma)", { key: keyLabel('mod') })} onClick={() => store.setPxPerSecond(store.getState().pxPerSecond * 1.4)} />
        </div>
      </div>
      <Timeline store={store} player={player} />
      {exportOpen && <ExportDialog store={store} player={player} onClose={() => store.setExportOpen(false)} />}
      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="modal settings-modal" role="dialog" aria-label={t("Ayarlar")}>
            <header>
              <div><h2>{t("Ayarlar")}</h2><p className="muted">{t("Dil, izinler ve kayıt yöntemleri")}</p></div>
              <IconButton icon="close" label={t("Kapat")} onClick={() => setSettingsOpen(false)} />
            </header>
            <Settings embedded />
          </div>
        </div>
      )}
    </div>
  );
}

/** Playhead time / total length. Follows playback on its own, so the editor around it is not redrawn each frame. */
function Timecode({ store }: { store: EditorStore }) {
  const playhead = useEditor(store, (s) => s.playhead);
  const project = useEditor(store, (s) => s.project);
  return <span className="timecode mono">{formatTimecode(playhead, project.sequence.fps)} <span className="muted">/ {formatTimecode(sequenceDuration(project))}</span></span>;
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    [t("Boşluk"), t("Oynat / duraklat")], ['← →', t("Kare kare ilerle ({key} ile 1 sn)", { key: keyLabel('shift') })], ['K', t("Dinamik kamera (kamerayı zaman aralığında taşı)")], ['C', t("Kesme modu (fareyle tıklayarak kes)")], ['S', t("Oynatma imlecinin olduğu yerden böl")],
    ['Z', t("Zoom aracı")], ['M', t("Büyüteç aracı")], ['B', t("Gizleme aracı")], [t("V / Esc"), t("Seçim aracı")], [t("Sil"), t("Seçili öğeyi sil")],
    [`${keyLabel('mod+Z')} / ${redoLabel()}`, t("Geri al / yinele")], [keyLabel('mod+E'), t("Dışa aktar")], [t("{key} + kaydırma", { key: keyLabel('mod') }), t("Zaman çizelgesi ölçeği")],
    [[RECORDING_KEYS.stop, RECORDING_KEYS.pause, RECORDING_KEYS.mark].map(keyLabel).join(' · '), t("Kayıtta: bitir · duraklat · işaret")],
  ];
  return (
    <div className="popover shortcut-help" role="dialog" aria-label={t("Klavye kısayolları")}>
      <header><strong>{t("Klavye kısayolları")}</strong><IconButton icon="close" label={t("Kapat")} onClick={onClose} /></header>
      <dl>{rows.map(([k, v]) => <div key={k}><dt><Kbd>{k}</Kbd></dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}

/**
 * Renders one frame at ~1 s into a small JPEG for the project list. It reads the recording
 * through its own media elements (renderStill): seeking the preview's elements would leave the
 * preview showing that frame instead of the one under the playhead.
 */
async function saveThumbnail(store: EditorStore): Promise<void> {
  const project = store.project;
  if (sequenceDuration(project) === 0) return;
  const at = Math.min(secondsToTicks(1), sequenceDuration(project) - 1);
  const { cursors, mediaBase } = store.getState();
  try {
    const jpeg = await renderStill(project, cursors, mediaBase, at, 'v_16x9', { width: 480, height: 270 });
    await api.setThumbnail(project.id, jpeg);
  } catch { /* thumbnail is optional */ }
}
