import { useEffect, useRef, useState } from 'react';
import {
  BACKGROUND_PRESETS, DEFAULT_CAMERA_MOVE, DEFAULT_CAMERA_SPLIT, MAGNIFIER_LIMITS, activeVariant, addCameraMoveAt, setCameraMovePosition, layoutSegments, presetTransition, removeCameraLayout,
  removeMagnifier, removePrivacy, removeSegment, removeZoom, resolvedBaseCamera, resolvedFrameStyle, setAudio, setStyle, setSyncOffset,
  setZoomSensitivity, timelineToSource, updateCameraLayout, updateMagnifier, updatePrivacy, updateVariant, updateZoom,
  type Background, type CameraLayout, type CameraShape, type DeepPartial, type Easing, type MagnifierShape, type MagnifierStyle,
  type PrivacyEffect, type Project, type Transition, type ZoomItem,
  pictureAspect,
} from '@zeyvola/project-model';
import { TICKS_PER_SECOND, formatTimecode, msToTicks, secondsToTicks, ticksToMs } from '@zeyvola/timing';
import type { Player } from '../../playback/player';
import { useEditor, type EditorStore, type InspectorTab } from '../../state/editor-store';
import { Button, ColorInput, Section, Segmented, Select, Slider, Swatch, Toggle } from '../../ui/controls';
import { Icon } from '../../ui/icons';
import { addMagnifierAt, place } from './placement';
import { PLACE_GRID, placeName } from './camera-names';
import { clearZoomSuggestions, noSuggestionMessage, runZoomSuggestions, type ZoomRun } from './zoom-actions';
import { t } from '../../i18n';
import { probe } from '../../perf-probe';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => t("{n} sn", { n: v.toFixed(2) });

type TransitionChoice = 'smooth' | 'fast' | 'custom' | 'instant';

function choiceOf(t: Transition): TransitionChoice {
  if (t.easing.kind === 'instant') return 'instant';
  if (t.easing.kind === 'preset') return t.easing.name;
  return 'custom';
}

function TransitionEditor({ label, value, onChange }: { label: string; value: Transition; onChange: (t: Transition, commit?: boolean) => void }) {
  const choice = choiceOf(value);
  const custom = value.easing.kind === 'bezier' || value.easing.kind === 'spring' || value.easing.kind === 'linear';
  return (
    <div className="field-group">
      <Segmented<TransitionChoice>
        label={label}
        size="sm"
        value={choice}
        options={[
          { value: 'smooth', label: t("Yumuşak") },
          { value: 'fast', label: t("Hızlı") },
          { value: 'custom', label: t("Özel") },
          { value: 'instant', label: t("Anlık") },
        ]}
        onChange={(c) => {
          if (c === 'smooth' || c === 'fast') onChange(presetTransition(c), true);
          else if (c === 'instant') onChange({ duration: 0, easing: { kind: 'instant' } }, true);
          else onChange({ duration: value.duration || secondsToTicks(0.6), easing: { kind: 'bezier', x1: 0.33, y1: 0, x2: 0.15, y2: 1 } }, true);
        }}
      />
      {custom && (
        <>
          <Slider label={t("Süre")} value={value.duration / TICKS_PER_SECOND} min={0.1} max={3} step={0.05} format={secs}
            onChange={(v) => onChange({ ...value, duration: secondsToTicks(v) })} />
          <Select<'bezier' | 'spring' | 'linear'>
            label={t("Eğri")}
            value={value.easing.kind as 'bezier' | 'spring' | 'linear'}
            options={[{ value: 'bezier', label: t("Yavaşlayarak") }, { value: 'spring', label: t("Yay") }, { value: 'linear', label: t("Doğrusal") }]}
            onChange={(k) => {
              const easing: Easing = k === 'spring' ? { kind: 'spring', zeta: 0.72, omega: 12 } : k === 'linear' ? { kind: 'linear' } : { kind: 'bezier', x1: 0.33, y1: 0, x2: 0.15, y2: 1 };
              onChange({ ...value, easing }, true);
            }}
          />
        </>
      )}
    </div>
  );
}

// ─── Selected item panels ─────────────────────────────────────────────────────

function ZoomTarget({ store, player, item }: { store: EditorStore; player: Player; item: ZoomItem }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rec = store.project.recordings[item.recordingId];
  const aspect = pictureAspect(rec?.sources.screen) ?? 16 / 10;
  useEffect(() => {
    const c = ref.current;
    const v = player.elementsFor(item.recordingId)?.screen;
    if (!c || !v) return;
    const draw = () => {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0f1012';
      ctx.fillRect(0, 0, c.width, c.height);
      if (v.readyState >= 2) ctx.drawImage(v, 0, 0, c.width, c.height);
    };
    draw();
    v.addEventListener('seeked', draw);
    return () => v.removeEventListener('seeked', draw);
  }, [item.recordingId, player]);
  const w = 1 / item.scale;
  const left = Math.min(1 - w, Math.max(0, item.center.x - w / 2));
  const top = Math.min(1 - w, Math.max(0, item.center.y - w / 2));
  const move = (e: React.PointerEvent) => {
    if (e.buttons !== 1) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const center = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    store.apply((p) => updateZoom(p, item.id, { center }), { coalesce: `zt-${item.id}` });
  };
  return (
    <div className="zoom-target" style={{ aspectRatio: String(aspect) }} onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); move(e); }} onPointerMove={move} onPointerUp={() => store.endGesture()}>
      <canvas ref={ref} width={320} height={Math.round(320 / aspect)} />
      <span className="zoom-target-rect" style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${w * 100}%`, height: `${w * 100}%` }} />
    </div>
  );
}

function SelectedPanel({ store, player }: { store: EditorStore; player: Player }) {
  const project = useEditor(store, (s) => s.project);
  const selection = useEditor(store, (s) => s.selection);
  const playhead = useEditor(store, (s) => s.settledPlayhead);
  if (!selection) return null;
  const close = () => store.select(null);
  const timeRange = (start: number, end: number) => <span className="muted mono">{formatTimecode(start)} – {formatTimecode(end)} · {t("{n} sn", { n: (Math.max(0, end - start) / TICKS_PER_SECOND).toFixed(1) })}</span>;

  if (selection.kind === 'zoom') {
    const z = project.zooms.find((i) => i.id === selection.id);
    if (!z) return null;
    const set = (patch: Parameters<typeof updateZoom>[2], commit = false) => store.apply((p) => updateZoom(p, z.id, patch), commit ? {} : { coalesce: `z-${z.id}` });
    return (
      <div className="selected-panel">
        <header><span className="dot" style={{ background: 'var(--track-zoom)' }} /><strong>{t("Zoom")}</strong>{z.origin === 'auto' && <span className="badge badge-accent">{t("Öneri")}</span>}<button className="link" onClick={close}>{t("Kapat")}</button></header>
        {timeRange(z.start, z.end)}
        <Segmented<'region' | 'follow'> size="sm" label={t("Mod")} value={z.mode} options={[{ value: 'region', label: t("Sabit hedef") }, { value: 'follow', label: t("İmleci takip") }]} onChange={(mode) => set({ mode }, true)} />
        <Slider label={t("Yakınlaştırma")} value={z.scale} min={1.1} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(scale) => set({ scale })} />
        {z.mode === 'region' && <ZoomTarget store={store} player={player} item={z} />}
        <TransitionEditor label={t("Giriş")} value={z.enter} onChange={(enter, c) => set({ enter } as never, c)} />
        <TransitionEditor label={t("Çıkış")} value={z.exit} onChange={(exit, c) => set({ exit } as never, c)} />
        <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removeZoom(p, z.id))}>{t("Zoom'u sil")}</Button>
      </div>
    );
  }

  if (selection.kind === 'magnifier') {
    const it = project.magnifiers.find((i) => i.id === selection.id);
    if (!it) return null;
    const L = MAGNIFIER_LIMITS;
    const set = (patch: Parameters<typeof updateMagnifier>[2]) => store.apply((p) => updateMagnifier(p, it.id, patch), { coalesce: `m-${it.id}` });
    return (
      <div className="selected-panel">
        <header><span className="dot" style={{ background: 'var(--track-magnifier)' }} /><strong>{t("Büyüteç")}</strong><button className="link" onClick={close}>{t("Kapat")}</button></header>
        {timeRange(it.start, it.end)}
        <Slider label={t("Boyut")} value={it.size} min={L.size.min} max={L.size.max} step={10} onChange={(size) => set({ size })} format={(v) => `${Math.round(v)} px`} />
        <Slider label={t("Yakınlaştırma")} value={it.zoom} min={L.zoom.min} max={L.zoom.max} step={0.05} onChange={(zoom) => set({ zoom })} format={(v) => `${v.toFixed(2)}×`} />
        <p className="muted small">{t("Lens bu aralıkta imleci takip eder; başında ve sonunda yumuşakça belirip kaybolur. Zaman çizelgesinde aralığı sürükleyerek taşıyın, kenarlarından tutup uzatın.")}</p>
        <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removeMagnifier(p, it.id))}>{t("Büyüteci sil")}</Button>
      </div>
    );
  }

  if (selection.kind === 'privacy') {
    const it = project.privacy.find((i) => i.id === selection.id);
    if (!it) return null;
    const set = (patch: Parameters<typeof updatePrivacy>[2], commit = false) => store.apply((p) => updatePrivacy(p, it.id, patch), commit ? {} : { coalesce: `p-${it.id}` });
    const kind = it.effect.kind;
    const notes: Record<PrivacyEffect['kind'], string> = {
      solid: t("Alanı tamamen kapatır. Hassas bilgiler için önerilen yöntem."),
      frosted: t("Bulanık görünür ama alanın içindeki hiçbir pikseli kullanmaz; içerik geri elde edilemez."),
      blur: t("Bulanıklaştırma her zaman geri döndürülemez değildir. Kısa metinler tahmin edilebilir."),
      pixelate: t("Pikselleştirme küçük metinlerde geri çözülebilir. Hassas bilgi için Opak kullanın."),
    };
    const pos = timelineToSource(project, playhead, layoutSegments(project));
    return (
      <div className="selected-panel">
        <header><span className="dot" style={{ background: 'var(--track-privacy)' }} /><strong>{t("Gizleme alanı")}</strong><button className="link" onClick={close}>{t("Kapat")}</button></header>
        {timeRange(it.start, it.end)}
        <Segmented<PrivacyEffect['kind']> size="sm" label={t("Efekt")} value={kind}
          options={[{ value: 'solid', label: t("Opak") }, { value: 'frosted', label: t("Buzlu cam") }, { value: 'blur', label: t("Bulanık") }, { value: 'pixelate', label: t("Piksel") }]}
          onChange={(k) => set({ effect: k === 'solid' ? { kind: 'solid', color: '#16171B' } : k === 'blur' ? { kind: 'blur', strength: 0.6 } : k === 'pixelate' ? { kind: 'pixelate', block: 18 } : { kind: 'frosted' } } as never, true)} />
        <p className={`note${kind === 'blur' || kind === 'pixelate' ? ' is-warning' : ''}`}><Icon name={kind === 'blur' || kind === 'pixelate' ? 'warning' : 'shield'} size={14} />{notes[kind]}</p>
        {it.effect.kind === 'solid' && <ColorInput label={t("Renk")} value={it.effect.color} onChange={(color) => set({ effect: { kind: 'solid', color } } as never)} />}
        {it.effect.kind === 'blur' && <Slider label={t("Yoğunluk")} value={it.effect.strength} min={0.2} max={1} onChange={(strength) => set({ effect: { kind: 'blur', strength } } as never)} format={pct} />}
        {it.effect.kind === 'pixelate' && <Slider label={t("Blok boyutu")} value={it.effect.block} min={12} max={64} step={1} onChange={(block) => set({ effect: { kind: 'pixelate', block } } as never)} format={(v) => `${v} px`} />}
        <Slider label={t("Köşe yuvarlaklığı")} value={it.cornerRadius} min={0} max={0.5} onChange={(cornerRadius) => set({ cornerRadius })} format={pct} />
        <Slider label={t("Güvenlik payı")} value={it.padFrames} min={0} max={10} step={1} onChange={(padFrames) => set({ padFrames })} format={(v) => t("{n} kare", { n: v })} />
        <div className="row-actions">
          <Button size="sm" icon="marker" disabled={!pos || pos.recordingId !== it.recordingId}
            onClick={() => {
              if (!pos) return;
              const t = pos.sourceTime;
              const region = it.keyframes.length ? it.keyframes.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)).region : it.region;
              const kf = [...it.keyframes.filter((k) => Math.abs(k.t - t) > secondsToTicks(1 / 60)), { t, region }].sort((a, b) => a.t - b.t);
              set({ keyframes: kf } as never, true);
            }}>{t("Bu kareye anahtar ekle")}</Button>
          {it.keyframes.length > 0 && <Button size="sm" variant="ghost" onClick={() => set({ keyframes: [], region: it.keyframes[0]!.region } as never, true)}>{t("Anahtarları temizle ({n})", { n: it.keyframes.length })}</Button>}
        </div>
        <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removePrivacy(p, it.id))}>{t("Alanı sil")}</Button>
      </div>
    );
  }

  if (selection.kind === 'camera') {
    const it = project.cameraLayouts.find((i) => i.id === selection.id);
    if (!it) return null;
    return (
      <div className="selected-panel">
        <header><span className="dot" style={{ background: 'var(--track-camera)' }} /><strong>{t("Kamera hareketi")}</strong><button className="link" onClick={close}>{t("Kapat")}</button></header>
        {timeRange(it.start, it.end)}
        <div className="cam-positions">
          {([1, 2] as const).map((which) => {
            const pos = which === 1 ? it.layout.position : it.second?.position;
            const size = which === 1 ? it.layout.size : it.second?.size ?? it.layout.size;
            const set = (patch: { position?: { x: number; y: number }; size?: number }, commit = true) =>
              store.apply((p) => setCameraMovePosition(p, it.id, which, patch), commit ? {} : { coalesce: `c-pos-${it.id}-${which}` });
            return (
              <div key={which} className={`cam-position${pos ? '' : ' is-empty'}`}>
                <header>
                  <span className="cam-badge">{which}</span>
                  <strong>{which === 1 ? t("1. konum") : t("2. konum")}</strong>
                  <span className="muted small">{pos ? placeName(pos) : t("Seçilmedi")}</span>
                </header>
                {!pos && <p className="muted small">{t("Önizlemede kameranın gideceği yere tıklayın ya da aşağıdan bir yer seçin.")}</p>}
                <div className="place-grid" role="radiogroup" aria-label={which === 1 ? t("1. konum") : t("2. konum")}>
                  {PLACE_GRID.map((c) => {
                    const on = !!pos && placeName(pos) === placeName(c);
                    return (
                      <button key={`${c.x}-${c.y}`} type="button" role="radio" aria-checked={on} className={on ? 'is-on' : ''} title={placeName(c)} onClick={() => set({ position: c })}>
                        <span />
                      </button>
                    );
                  })}
                </div>
                {pos && <Slider label={t("Boyut")} value={size} min={0.1} max={0.95} onChange={(v) => set({ size: v }, false)} format={pct} />}
              </div>
            );
          })}
        </div>
        <Slider label={t("Hareket anı")} value={it.split ?? DEFAULT_CAMERA_SPLIT} min={0.1} max={0.9} step={0.01}
          onChange={(split) => store.apply((p) => updateCameraLayout(p, it.id, { split }), { coalesce: `c-split-${it.id}` })} format={pct} />
        <TransitionEditor label={t("Geçiş")} value={it.enter} onChange={(enter, c) => store.apply((p) => updateCameraLayout(p, it.id, { enter } as never), c ? {} : { coalesce: `c-${it.id}` })} />
        <CameraFields layout={it.layout} compact onChange={(layout, commit) => store.apply((p) => updateCameraLayout(p, it.id, { layout } as never), commit ? {} : { coalesce: `c-${it.id}` })} />
        <Button icon="trash" variant="ghost" size="sm" onClick={() => store.apply((p) => removeCameraLayout(p, it.id))}>{t("Düzen değişikliğini sil")}</Button>
      </div>
    );
  }

  const seg = project.sequence.segments.find((s) => s.id === selection.id);
  if (!seg) return null;
  return (
    <div className="selected-panel">
      <header><span className="dot" style={{ background: 'var(--track-screen)' }} /><strong>{t("Bölüm")}</strong><button className="link" onClick={close}>{t("Kapat")}</button></header>
      <span className="muted mono">{t("Kayıt içi")} {formatTimecode(seg.sourceStart)} – {formatTimecode(seg.sourceEnd)}</span>
      <p className="note"><Icon name="info" size={14} />{t("Ekran, kamera ve ses birlikte kesilir. Böl:")} <kbd className="kbd">S</kbd></p>
      <Button icon="trash" variant="ghost" size="sm" disabled={project.sequence.segments.length < 2} onClick={() => store.apply((p) => removeSegment(p, seg.id))}>{t("Bölümü sil")}</Button>
    </div>
  );
}

// ─── Shared camera controls ───────────────────────────────────────────────────

/** Camera look. `compact` (inside a camera move) leaves out size and position, which each of the move's positions has. */
function CameraFields({ layout, onChange, compact = false }: { layout: CameraLayout; onChange: (patch: Partial<CameraLayout>, commit?: boolean) => void; compact?: boolean }) {
  const shapes: { value: CameraShape; label: string }[] = [
    { value: 'circle', label: t("Daire") }, { value: 'squircle', label: t("Yumuşak kare") }, { value: 'rounded', label: t("Yuvarlak köşe") },
    { value: 'square', label: t("Kare") }, { value: 'rect', label: t("Dikdörtgen") }, { value: 'free', label: t("Serbest") },
  ];
  const corners: { label: string; pos: { x: number; y: number } }[] = [
    { label: t("Sol üst"), pos: { x: 0.12, y: 0.2 } }, { label: t("Sağ üst"), pos: { x: 0.885, y: 0.2 } }, { label: t("Orta"), pos: { x: 0.5, y: 0.5 } },
    { label: t("Sol alt"), pos: { x: 0.12, y: 0.8 } }, { label: t("Sağ alt"), pos: { x: 0.885, y: 0.8 } }, { label: t("Alt orta"), pos: { x: 0.5, y: 0.82 } },
  ];
  return (
    <>
      <Toggle label={t("Görünür")} checked={layout.visible} onChange={(visible) => onChange({ visible }, true)} />
      <div className="shape-grid" role="radiogroup" aria-label={t("Şekil")}>
        {shapes.map((s) => (
          <button key={s.value} type="button" role="radio" aria-checked={layout.shape === s.value} className={`shape-btn${layout.shape === s.value ? ' is-on' : ''}`} onClick={() => onChange({ shape: s.value }, true)}>
            <span className={`shape-glyph shape-${s.value}`} />
            <small>{s.label}</small>
          </button>
        ))}
      </div>
      {!compact && <Slider label={t("Boyut")} value={layout.size} min={0.1} max={0.95} onChange={(size) => onChange({ size })} format={pct} />}
      {(layout.shape === 'rounded' || layout.shape === 'rect' || layout.shape === 'free') && (
        <Slider label={t("Köşe yuvarlaklığı")} value={layout.cornerRadius} min={0} max={0.5} onChange={(cornerRadius) => onChange({ cornerRadius })} format={pct} />
      )}
      {layout.shape === 'free' && <Slider label={t("En/boy oranı")} value={layout.aspect} min={0.4} max={2.5} onChange={(aspect) => onChange({ aspect })} format={(v) => v.toFixed(2)} />}
      <Slider label={t("Kamera içi yakınlaştırma")} value={layout.zoom} min={1} max={2.5} onChange={(zoom) => onChange({ zoom })} format={(v) => `${v.toFixed(2)}×`} />
      {!compact && (
        <div className="pos-grid" aria-label={t("Konum")}>
          {corners.map((c) => <button key={c.label} type="button" className="pos-btn" title={c.label} onClick={() => onChange({ position: c.pos }, true)}><span style={{ left: `${c.pos.x * 100}%`, top: `${c.pos.y * 100}%` }} /></button>)}
        </div>
      )}
      <Slider label={t("Kenarlık")} value={layout.border.width} min={0} max={12} step={0.5} onChange={(width) => onChange({ border: { ...layout.border, width } })} format={(v) => `${v} px`} />
      {layout.border.width > 0 && <ColorInput label={t("Kenarlık rengi")} value={layout.border.color} onChange={(color) => onChange({ border: { ...layout.border, color } })} />}
      <Slider label={t("Gölge")} value={layout.shadow.opacity} min={0} max={0.8} onChange={(opacity) => onChange({ shadow: { ...layout.shadow, opacity } })} format={pct} />
      <Toggle label={t("Ayna görüntüsü")} checked={layout.mirror} onChange={(mirror) => onChange({ mirror }, true)} />
    </>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function StyleTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const variant = activeVariant(project);
  const frame = resolvedFrameStyle(project, variant);
  const bg = project.style.background;
  const setBg = (background: Background) => store.apply((p) => setStyle(p, { background } as never));
  const setFrame = (patch: Partial<typeof frame>, commit = false) => {
    const variantKeys = ['aspectMode', 'area'];
    const isVariantKey = Object.keys(patch).some((k) => variantKeys.includes(k)) || (variant.frameOverride && Object.keys(patch).some((k) => k in (variant.frameOverride ?? {})));
    store.apply((p) => (isVariantKey ? updateVariant(p, variant.id, { frameOverride: patch }) : setStyle(p, { frame: patch })), commit ? {} : { coalesce: 'frame' });
  };
  const presetColors = (b: Background): string[] => (b.kind === 'solid' ? [b.color] : b.kind === 'gradient' ? [b.from, b.to] : b.kind === 'aurora' ? [...b.colors] : ['#333']);
  return (
    <>
      <Section title={t("Arka plan")}>
        <div className="swatch-grid">
          {BACKGROUND_PRESETS.map((p) => (
            <Swatch key={p.id} label={p.name} colors={presetColors(p.background)} active={JSON.stringify(p.background) === JSON.stringify(bg)} onClick={() => setBg(p.background)} />
          ))}
        </div>
        <Segmented<'solid' | 'gradient' | 'aurora'> size="sm" label={t("Tür")} value={bg.kind === 'image' ? 'solid' : bg.kind}
          options={[{ value: 'solid', label: t("Düz") }, { value: 'gradient', label: t("Geçişli") }, { value: 'aurora', label: t("Işıltı") }]}
          onChange={(k) => setBg(k === 'solid' ? { kind: 'solid', color: '#17181C' } : k === 'gradient' ? { kind: 'gradient', from: '#1F2B24', to: '#7FB08E', angle: 135 } : BACKGROUND_PRESETS[0]!.background)} />
        {bg.kind === 'solid' && <ColorInput label={t("Renk")} value={bg.color} onChange={(color) => setBg({ kind: 'solid', color })} />}
        {bg.kind === 'gradient' && (
          <>
            <ColorInput label={t("Başlangıç")} value={bg.from} onChange={(from) => setBg({ ...bg, from })} />
            <ColorInput label={t("Bitiş")} value={bg.to} onChange={(to) => setBg({ ...bg, to })} />
            <Slider label={t("Açı")} value={bg.angle} min={0} max={360} step={1} onChange={(angle) => setBg({ ...bg, angle })} format={(v) => `${Math.round(v)}°`} />
          </>
        )}
        {bg.kind === 'aurora' && (
          <>
            <div className="color-quad">{bg.colors.map((c, i) => <ColorInput key={i} label={[t("Taban"), t("Işık 1"), t("Işık 2"), t("Vurgu")][i]!} value={c} onChange={(v) => { const colors = [...bg.colors] as typeof bg.colors; colors[i] = v; setBg({ ...bg, colors }); }} />)}</div>
            <Slider label={t("Dağılım")} value={bg.seed} min={1} max={40} step={1} onChange={(seed) => setBg({ ...bg, seed })} format={(v) => String(v)} />
            <Slider label={t("Doku")} value={bg.grain} min={0} max={0.08} step={0.005} onChange={(grain) => setBg({ ...bg, grain })} format={(v) => pct(v / 0.08)} />
          </>
        )}
      </Section>
      <Section title={t("Ekran çerçevesi · {name}", { name: variant.name })}>
        <Segmented<'source' | 'fill'> size="sm" label={t("Yerleşim")} value={frame.aspectMode}
          options={[{ value: 'source', label: t("Kayıt oranı") }, { value: 'fill', label: t("Alanı doldur") }]}
          onChange={(aspectMode) => setFrame({ aspectMode }, true)} />
        <Slider label={t("Kenar boşluğu")} value={frame.padding} min={0} max={0.16} step={0.005} onChange={(padding) => setFrame({ padding })} format={(v) => (v <= 0.0005 ? t("Yok") : pct(v / 0.16))} />
        {frame.padding <= 0.0005 && <p className="muted small">{t("Ekran kenardan kenara dolduruyor. Kayıt oranı farklıysa hafifçe kırpılır; köşe, gölge ve kenarlık bu modda uygulanmaz.")}</p>}
        <Slider label={t("Köşe yuvarlaklığı")} value={frame.radius} min={0} max={40} step={1} onChange={(radius) => setFrame({ radius })} format={(v) => `${v} px`} />
        <Slider label={t("Gölge")} value={frame.shadow.opacity} min={0} max={0.8} onChange={(opacity) => setFrame({ shadow: { ...frame.shadow, opacity } })} format={pct} />
        <Slider label={t("Gölge yumuşaklığı")} value={frame.shadow.blur} min={0} max={120} step={1} onChange={(blur) => setFrame({ shadow: { ...frame.shadow, blur } })} format={(v) => `${v} px`} />
        <Slider label={t("Kenarlık")} value={frame.border.width} min={0} max={8} step={0.5} onChange={(width) => setFrame({ border: { ...frame.border, width } })} format={(v) => `${v} px`} />
        {frame.border.width > 0 && <ColorInput label={t("Kenarlık rengi")} value={frame.border.color} onChange={(color) => setFrame({ border: { ...frame.border, color } })} />}
      </Section>
    </>
  );
}

function CameraTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const playhead = useEditor(store, (s) => s.settledPlayhead);
  const variant = activeVariant(project);
  const base = resolvedBaseCamera(project, variant);
  const hasCamera = Object.values(project.recordings).some((r) => r.sources.camera);
  if (!hasCamera) return <p className="note"><Icon name="info" size={14} />{t("Bu projedeki kayıtlarda kamera görüntüsü yok.")}</p>;
  const setBase = (patch: Partial<CameraLayout>, commit?: boolean) =>
    store.apply((p) => (variant.cameraOverride ? updateVariant(p, variant.id, { cameraOverride: patch }) : setStyle(p, { camera: patch })), commit ? {} : { coalesce: 'cam-base' });
  /** Quick move from the playhead: starts where the camera is and goes to `to`. */
  const addMoveTo = (to: { position: { x: number; y: number }; size: number }) => {
    const r = addCameraMoveAt(project, store.getState().playhead, to);
    if (!r) { store.notify(t("Burada yeni kamera hareketine yer yok.")); return; }
    store.apply(() => r.project);
    store.select({ kind: 'camera', id: r.id });
  };
  const addChange = (layout: CameraLayout) => {
    const pos = timelineToSource(project, store.getState().playhead, layoutSegments(project));
    if (!pos) return;
    place(store, 'cameraLayouts', {
      recordingId: pos.recordingId, start: pos.sourceTime, end: Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + DEFAULT_CAMERA_MOVE),
      origin: 'manual', layout, enter: presetTransition('smooth'),
    });
  };
  return (
    <>
      <Section title={t("Varsayılan düzen · {name}", { name: variant.name })}>
        <CameraFields layout={base} onChange={setBase} />
      </Section>
      <Section title={t("Dinamik kamera")}>
        <p className="muted small">{t("Her kamera hareketinin iki konumu vardır: 1. konum kameranın başladığı yer, 2. konum gideceği yer. Zaman çizelgesinde bir ana basarak hareket ekleyin, sonra önizlemede 2. konumu seçin. Aralık bitince kamera eski yerine döner.")}</p>
        <div className="row-actions">
          <Button size="sm" variant="primary" icon="camera" onClick={() => store.setTool('camera')}>{t("Kamera aracını seç")}</Button>
        </div>
        <p className="muted small">{t("Hazır hareketler (oynatma çubuğundan başlar):")}</p>
        <div className="row-actions">
          <Button size="sm" icon="layout" onClick={() => addMoveTo({ position: { x: 0.5, y: 0.5 }, size: Math.min(0.62, base.size * 2.2) })}>{t("Büyüt ve ortala")}</Button>
          <Button size="sm" icon="layout" onClick={() => addMoveTo({ position: { x: 0.12, y: base.position.y }, size: base.size })}>{t("Sola al")}</Button>
          <Button size="sm" icon="privacy" onClick={() => addChange({ ...base, visible: false })}>{t("Bu aralıkta gizle")}</Button>
        </div>
      </Section>
    </>
  );
}

function CursorTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const c = project.style.cursor;
  const baked = Object.values(project.recordings).every((r) => r.capture.cursorInFrames);
  const set = (patch: Partial<typeof c>, commit = false) => store.apply((p) => setStyle(p, { cursor: patch }), commit ? {} : { coalesce: 'cursor' });
  return (
    <>
      {baked && <p className="note is-warning"><Icon name="warning" size={14} />{t("Bu kayıtta imleç görüntüye işlenmiş (tarayıcı yedek kaydı). İmleç efektleri yalnızca yerel kayıtla alınan kayıtlarda çalışır.")}</p>}
      <Section title={t("İmleç")}>
        <Toggle label={t("İmleci göster")} checked={c.visible} onChange={(visible) => set({ visible }, true)} disabled={baked} />
        <Slider label={t("Boyut")} value={c.scale} min={0.6} max={3} onChange={(scale) => set({ scale })} format={(v) => `${v.toFixed(2)}×`} />
        <Slider label={t("Hareket yumuşatma")} value={c.smoothing} min={0} max={1} onChange={(smoothing) => set({ smoothing })} format={pct} />
        <Segmented<'none' | 'ring' | 'pulse'> size="sm" label={t("Tıklama efekti")} value={c.clickEffect}
          options={[{ value: 'none', label: t("Yok") }, { value: 'ring', label: t("Halka") }, { value: 'pulse', label: t("Dalga") }]} onChange={(clickEffect) => set({ clickEffect }, true)} />
        <Toggle label={t("Hareketsizken gizle")} hint={t("1,6 sn hareket yoksa yavaşça kaybolur")} checked={c.hideWhenIdle} onChange={(hideWhenIdle) => set({ hideWhenIdle }, true)} />
      </Section>
    </>
  );
}

function MagnifierTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const cursors = useEditor(store, (s) => s.cursors);
  const playhead = useEditor(store, (s) => s.settledPlayhead);
  const m = project.style.magnifier;
  const L = MAGNIFIER_LIMITS;
  const count = project.magnifiers.length;
  const noPointer = !Object.values(project.recordings).some((r) => cursors[r.id]?.hasSamples);
  const set = (patch: DeepPartial<MagnifierStyle>, commit = false) => store.apply((p) => setStyle(p, { magnifier: patch }), commit ? {} : { coalesce: 'magnifier' });
  return (
    <>
      {noPointer && <p className="note is-warning"><Icon name="warning" size={14} />{t("Bu projedeki kayıtlarda imleç verisi yok. Büyüteç yalnızca imleç hareketi kaydedilmiş kayıtlarda görünür.")}</p>}
      <Section title={t("Büyüteç aralıkları")}>
        <p className="muted small">{t("Büyüteç yalnızca seçtiğiniz zaman aralıklarında görünür: imleci takip eden bir mercek, altındaki ekranı büyütür. Aralığı zaman çizelgesindeki Büyüteç satırında sürükleyerek çizin ya da Büyüteç aracıyla istediğiniz ana basın.")}</p>
        <div className="row-actions">
          <Button size="sm" variant="primary" icon="magnifier" onClick={() => store.setTool('magnifier')}>{t("Büyüteç aracını seç")}</Button>
          <Button size="sm" icon="plus" onClick={() => addMagnifierAt(store, store.getState().playhead)}>{t("Oynatma imlecine ekle")}</Button>
        </div>
        <span className="muted small">{count === 0 ? t("Henüz büyüteç aralığı yok.") : t("{n} aralık · ayarlamak için zaman çizelgesinde birine tıklayın", { n: count })}</span>
      </Section>
      <Section title={t("Yeni aralıklar için")}>
        <Slider label={t("Boyut")} value={m.size} min={L.size.min} max={L.size.max} step={10} onChange={(size) => set({ size })} format={(v) => `${Math.round(v)} px`} />
        <Slider label={t("Yakınlaştırma")} value={m.zoom} min={L.zoom.min} max={L.zoom.max} step={0.05} onChange={(zoom) => set({ zoom })} format={(v) => `${v.toFixed(2)}×`} />
      </Section>
      <Section title={t("Görünüm · tüm aralıklar")}>
        <Segmented<MagnifierShape> size="sm" label={t("Şekil")} value={m.shape}
          options={[{ value: 'circle', label: t("Daire") }, { value: 'rounded', label: t("Yuvarlak köşe") }]} onChange={(shape) => set({ shape }, true)} />
        <Slider label={t("Kenarlık")} value={m.border.width} min={L.border.min} max={L.border.max} step={0.5} onChange={(width) => set({ border: { width } })} format={(v) => `${v} px`} />
        {m.border.width > 0 && <ColorInput label={t("Kenarlık rengi")} value={m.border.color} onChange={(color) => set({ border: { color } })} />}
        <Toggle label={t("Hareketsizken gizle")} hint={t("1,6 sn hareket yoksa yavaşça kaybolur")} checked={m.hideWhenIdle} onChange={(hideWhenIdle) => set({ hideWhenIdle }, true)} />
      </Section>
    </>
  );
}

function AudioTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const a = project.audio;
  const recs = Object.values(project.recordings);
  return (
    <>
      <Section title={t("Ses düzeyleri")}>
        <Slider label={t("Mikrofon")} value={a.mic.gain} min={0} max={1} onChange={(gain) => store.apply((p) => setAudio(p, { mic: { gain } }), { coalesce: 'mic' })} format={pct} />
        <Toggle label={t("Mikrofonu sessize al")} checked={a.mic.muted} onChange={(muted) => store.apply((p) => setAudio(p, { mic: { muted } }))} />
        <Slider label={t("Sistem sesi")} value={a.system.gain} min={0} max={1} onChange={(gain) => store.apply((p) => setAudio(p, { system: { gain } }), { coalesce: 'sys' })} format={pct} />
        <Toggle label={t("Sistem sesini sessize al")} checked={a.system.muted} onChange={(muted) => store.apply((p) => setAudio(p, { system: { muted } }))} />
      </Section>
      {recs.map((r, i) => (
        <Section key={r.id} title={t("Senkron · Kayıt {n}", { n: i + 1 })} defaultOpen={false}>
          <p className="muted small">{t("Bir kaynak geç geliyorsa kaydırın. Pozitif değer kaynağı geciktirir.")}</p>
          {(['camera', 'mic', 'system'] as const).filter((k) => r.sources[k]).map((k) => (
            <Slider key={k} label={{ camera: t("Kamera"), mic: t("Mikrofon"), system: t("Sistem sesi") }[k]} value={ticksToMs(r.syncOffsets[k] ?? 0)} min={-500} max={500} step={5}
              onChange={(ms) => store.apply((p) => setSyncOffset(p, r.id, k, msToTicks(ms)), { coalesce: `sync-${r.id}-${k}` })} format={(v) => `${Math.round(v)} ms`} />
          ))}
        </Section>
      ))}
    </>
  );
}

function ZoomTab({ store }: { store: EditorStore }) {
  const project = useEditor(store, (s) => s.project);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ZoomRun | null>(null);
  const auto = project.zooms.filter((z) => z.origin === 'auto').length;
  const manual = project.zooms.length - auto;
  const noClicks = Object.values(project.recordings).some((r) => !r.capture.hasClicks);
  const d = project.style.zoomDefaults;
  const run = async () => {
    setBusy(true);
    try { setLast(await runZoomSuggestions(store)); } finally { setBusy(false); }
  };
  return (
    <>
      <Section title={t("Otomatik zoom")}>
        <p className="muted small">{t("İmleç hareketleri ve tıklamalardan öneri üretir. Elle düzenlediğiniz zoom'lara dokunmaz.")}</p>
        <Segmented<Project['zoomEngine']['sensitivity']> size="sm" label={t("Hassasiyet")} value={project.zoomEngine.sensitivity}
          options={[{ value: 'low', label: t("Az") }, { value: 'medium', label: t("Orta") }, { value: 'high', label: t("Çok") }]}
          onChange={(s) => store.apply((p) => setZoomSensitivity(p, s))} />
        <div className="row-actions">
          <Button size="sm" variant="primary" icon="sparkle" onClick={run} disabled={busy}>{busy ? t("Hesaplanıyor…") : t("Önerileri oluştur")}</Button>
          {auto > 0 && <Button size="sm" variant="ghost" onClick={() => clearZoomSuggestions(store)}>{t("Önerileri temizle")}</Button>}
        </div>
        <span className="muted small">{t("{auto} öneri · {manual} elle düzenlenmiş", { auto, manual })}{last !== null ? t(" · son çalıştırma: {n} öneri", { n: last.count }) : ''}</span>
        {last?.reason && <p className="note" role="status"><Icon name="info" size={14} />{noSuggestionMessage(last.reason)}</p>}
        {noClicks && <p className="note"><Icon name="info" size={14} />{t("Bazı kayıtlarda tıklama verisi yok. Bunlar için öneriler imlecin durduğu noktalardan üretilir.")}</p>}
      </Section>
      <Section title={t("Varsayılanlar")}>
        <Slider label={t("Yakınlaştırma")} value={d.scale} min={1.2} max={3.5} step={0.05} format={(v) => `${v.toFixed(2)}×`}
          onChange={(scale) => store.apply((p) => setStyle(p, { zoomDefaults: { scale } }), { coalesce: 'zd' })} />
        <TransitionEditor label={t("Geçiş")} value={d.enter} onChange={(t, c) => store.apply((p) => setStyle(p, { zoomDefaults: { enter: t, exit: t } } as never), c ? {} : { coalesce: 'zd' })} />
        <p className="muted small">{t("Kısayol: önizlemede")} <kbd className="kbd">Z</kbd> {t("ile tıkladığınız noktaya zoom ekleyin.")}</p>
      </Section>
    </>
  );
}

export function Inspector({ store, player }: { store: EditorStore; player: Player }) {
  probe.count('react:Inspector');
  const tab = useEditor(store, (s) => s.tab);
  return (
    <aside className="inspector">
      <SelectedPanel store={store} player={player} />
      <div className="inspector-tabs">
        <Segmented<InspectorTab>
          size="sm"
          label={t("Ayar grubu")}
          value={tab}
          onChange={(t) => store.setTab(t)}
          options={[
            { value: 'style', label: t("Stil"), icon: 'brush' },
            { value: 'camera', label: t("Kamera"), icon: 'camera' },
            { value: 'cursor', label: t("İmleç"), icon: 'cursor' },
            { value: 'magnifier', label: t("Büyüteç"), icon: 'magnifier' },
            { value: 'audio', label: t("Ses"), icon: 'speaker' },
            { value: 'zoom', label: t("Zoom"), icon: 'zoom' },
          ]}
        />
      </div>
      <div className="inspector-body">
        {tab === 'style' && <StyleTab store={store} />}
        {tab === 'camera' && <CameraTab store={store} />}
        {tab === 'cursor' && <CursorTab store={store} />}
        {tab === 'magnifier' && <MagnifierTab store={store} />}
        {tab === 'audio' && <AudioTab store={store} />}
        {tab === 'zoom' && <ZoomTab store={store} />}
      </div>
    </aside>
  );
}
