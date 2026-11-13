import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Compositor } from '@zeyvola/compositor';
import {
  activeVariant, addCameraMoveAt, cameraFrameFor, cameraSecondLayout, canvasToSource, clampRectTo01, conflictsFor, evaluate,
  layoutSegments, normalizeRect, privacyRegionAt, setCameraMovePosition, sourceToCanvas, suggestedSecondPosition, timelineToSource,
  updateCameraLayout, updatePrivacy, updateVariant, updateZoom, setStyle, type Rect, type RenderPlan, type Vec2,
} from '@zeyvola/project-model';
import { secondsToTicks } from '@zeyvola/timing';
import type { Player } from '../../playback/player';
import { addMagnifierAt, place } from './placement';
import { placeName } from './camera-names';
import { useEditor, type EditorStore } from '../../state/editor-store';
import { t } from '../../i18n';
import { probe } from '../../perf-probe';

interface Box { x: number; y: number; w: number; h: number }

type Drag =
  | { kind: 'draw'; start: Vec2; current: Vec2 }
  | { kind: 'privacy'; id: string; mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'; origin: Vec2; region: Rect }
  | { kind: 'camera'; origin: Vec2; position: Vec2; target: 'item' | 'variant' | 'style'; itemId?: string }
  | { kind: 'pos'; id: string; which: 1 | 2; offset: Vec2 }
  | { kind: 'possize'; id: string; which: 1 | 2; center: Vec2; dist0: number; size0: number };

interface CamShape { rect: Rect; radius: number; cornerExponent: number }

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export function Preview({ store, player }: { store: EditorStore; player: Player }) {
  probe.count('react:Preview');
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // Counts lost WebGL contexts; each loss builds a new canvas and compositor.
  const [glGeneration, setGlGeneration] = useState(0);
  const compRef = useRef<Compositor | null>(null);
  const planRef = useRef<RenderPlan | null>(null);
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The overlay (camera outline, privacy box) is drawn from the last rendered plan; this
  // re-renders it whenever that geometry changes, so it never lags behind the canvas.
  const [, setOverlayVersion] = useState(0);
  const overlayKey = useRef('');
  const project = useEditor(store, (s) => s.project);
  const selection = useEditor(store, (s) => s.selection);
  const tool = useEditor(store, (s) => s.tool);
  const cursors = useEditor(store, (s) => s.cursors);
  const variant = activeVariant(project);
  const aspect = variant.width / variant.height;

  // Fit the canvas into the stage at the variant's aspect ratio.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const pad = 28;
      const W = el.clientWidth - pad * 2;
      const H = el.clientHeight - pad * 2;
      let w = W;
      let h = W / aspect;
      if (h > H) { h = H; w = H * aspect; }
      setBox({ x: (el.clientWidth - w) / 2, y: (el.clientHeight - h) / 2, w: Math.max(0, w), h: Math.max(0, h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  // The canvas belongs to its compositor: a closed compositor gives its WebGL context back
  // (Compositor.dispose) and that canvas cannot draw again, so each one gets a fresh canvas.
  // If the browser takes the context away (GPU reset, too many contexts), the preview rebuilds.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    host.appendChild(canvas);
    const onLost = (e: Event) => { e.preventDefault(); setGlGeneration((g) => g + 1); };
    canvas.addEventListener('webglcontextlost', onLost);
    try {
      compRef.current = new Compositor(canvas);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      compRef.current?.dispose();
      compRef.current = null;
      canvas.remove();
    };
  }, [glGeneration]);

  const render = useCallback(() => {
    const comp = compRef.current;
    if (!comp || comp.lost || box.w < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(dpr, variant.width / box.w);
    const width = Math.round(box.w * scale);
    const height = Math.round(box.h * scale);
    const s = store.getState();
    const t0 = probe.on ? performance.now() : 0;
    const plan = evaluate(s.project, s.playhead, { cursors: s.cursors, size: { width, height } });
    planRef.current = plan;
    const key = JSON.stringify([plan.camera?.rect, plan.screen?.frame, plan.screen?.viewport, plan.sourceTime]);
    if (key !== overlayKey.current) {
      overlayKey.current = key;
      if (s.tool === 'camera' || s.selection?.kind === 'privacy' || s.selection?.kind === 'camera') setOverlayVersion((v) => v + 1);
    }
    const m = plan.recordingId ? player.elementsFor(plan.recordingId) : undefined;
    const screen = m?.screen && m.screen.readyState >= 2 ? m.screen : null;
    const camera = m?.camera && m.camera.readyState >= 2 ? m.camera : null;
    try {
      comp.render(plan, {
        screen, screenSize: screen ? { width: screen.videoWidth, height: screen.videoHeight } : undefined,
        camera, cameraSize: camera ? { width: camera.videoWidth, height: camera.videoHeight } : undefined,
      });
    } catch (e) {
      setError((e as Error).message);
    }
    if (probe.on) probe.record('preview-draw', performance.now() - t0);
  }, [box, player, store, variant.width]);

  // Coalesce redraw requests into one per animation frame.
  const pending = useRef(0);
  const requestRender = useCallback(() => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => { pending.current = 0; render(); });
  }, [render]);

  useEffect(() => { requestRender(); }, [project, cursors, box, glGeneration, requestRender]);
  // The playhead redraws the canvas only; the overlay around it is redrawn when its geometry
  // changes (overlayKey in render), not on every frame of playback.
  useEffect(() => {
    let last = store.getState().playhead;
    return store.subscribe(() => {
      const now = store.getState().playhead;
      if (now !== last) { last = now; requestRender(); }
    });
  }, [store, requestRender]);
  useEffect(() => player.onFrame(requestRender), [player, requestRender]);

  // ─── Coordinate helpers (CSS px inside the canvas ↔ render px) ────────────
  const toRender = (p: Vec2): Vec2 => {
    const plan = planRef.current;
    if (!plan) return p;
    return { x: (p.x / box.w) * plan.width, y: (p.y / box.h) * plan.height };
  };
  const toCss = (p: Vec2): Vec2 => {
    const plan = planRef.current;
    if (!plan) return p;
    return { x: (p.x / plan.width) * box.w, y: (p.y / plan.height) * box.h };
  };
  const local = (e: RPointerEvent): Vec2 => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toSource = (css: Vec2): Vec2 | null => {
    const plan = planRef.current;
    if (!plan) return null;
    const p = toRender(css);
    return canvasToSource(plan, p.x, p.y);
  };

  const activePrivacy = selection?.kind === 'privacy' ? project.privacy.find((p) => p.id === selection.id) : undefined;
  const plan = planRef.current;
  const sourceTime = plan?.sourceTime ?? null;
  const privacyVisible = activePrivacy && sourceTime !== null && activePrivacy.recordingId === plan?.recordingId
    && sourceTime >= activePrivacy.start && sourceTime < activePrivacy.end;

  const regionCss = (region: Rect): Box | null => {
    if (!plan) return null;
    const a = sourceToCanvas(plan, { x: region.x, y: region.y });
    const b = sourceToCanvas(plan, { x: region.x + region.w, y: region.y + region.h });
    if (!a || !b) return null;
    const ca = toCss(a);
    const cb = toCss(b);
    return { x: ca.x, y: ca.y, w: cb.x - ca.x, h: cb.y - ca.y };
  };

  /** CSS corner radius matching the camera's shape (squircles approximated). */
  const camRadius = (c: CamShape): string | number => {
    if (c.cornerExponent > 3) return '32%';
    if (c.radius >= Math.min(c.rect.w, c.rect.h) / 2 - 1) return '50%';
    return plan ? (c.radius * box.w) / plan.width : 12;
  };
  const camCenterCss = (r: Rect) => toCss({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const inside = (r: Rect, rp: Vec2) => rp.x >= r.x && rp.x <= r.x + r.w && rp.y >= r.y && rp.y <= r.y + r.h;

  // ─── Dynamic camera: the move being edited and its two positions ──────────
  // The selected camera move or, with the camera tool, the one under the playhead.
  const selectedMove = selection?.kind === 'camera' ? project.cameraLayouts.find((c) => c.id === selection.id) : undefined;
  const coveringMove = plan?.recordingId && sourceTime !== null
    ? project.cameraLayouts.find((c) => c.recordingId === plan.recordingId && c.start <= sourceTime && sourceTime < c.end)
    : undefined;
  const activeMove = tool === 'camera' ? selectedMove ?? coveringMove : tool === 'select' ? selectedMove : undefined;
  const moveFrames = (() => {
    if (!activeMove || !plan || !activeMove.layout.visible) return null;
    const size = { width: plan.width, height: plan.height };
    const second = cameraSecondLayout(activeMove);
    const one = cameraFrameFor(project, activeMove.recordingId, activeMove.layout, size);
    const two = cameraFrameFor(project, activeMove.recordingId, second ?? { ...activeMove.layout, position: suggestedSecondPosition(activeMove.layout.position) }, size);
    return one && two ? { id: activeMove.id, one, two, picked: !!second, p1: activeMove.layout.position, p2: activeMove.second?.position } : null;
  })();

  const canvasPos = (p: Vec2): Vec2 => ({ x: p.x / box.w, y: p.y / box.h });
  const setPos = (id: string, which: 1 | 2, patch: { position?: Vec2; size?: number }) =>
    store.apply((pr) => setCameraMovePosition(pr, id, which, patch), { coalesce: `cam-pos-${id}-${which}` });
  const startPosResize = (e: RPointerEvent, which: 1 | 2) => {
    const plan = planRef.current;
    if (!plan || !moveFrames) return;
    e.stopPropagation();
    const overlay = (e.currentTarget as HTMLElement).closest('.preview-overlay') as HTMLElement;
    overlay.setPointerCapture(e.pointerId);
    const r = overlay.getBoundingClientRect();
    const f = which === 1 ? moveFrames.one : moveFrames.two;
    const center = camCenterCss(f.rect);
    if (which === 2 && !moveFrames.picked) setPos(moveFrames.id, 2, { position: canvasPos(center) });
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    setDrag({ kind: 'possize', id: moveFrames.id, which, center, dist0: Math.max(4, Math.hypot(p.x - center.x, p.y - center.y)), size0: f.rect.h / plan.height });
  };

  const onPointerDown = (e: RPointerEvent) => {
    const p = local(e);
    const s = store.getState();
    const plan = planRef.current;
    if (!plan) return;
    if (s.tool === 'cut') return; // cutting happens on the timeline
    if (s.tool === 'camera' || (s.tool === 'select' && moveFrames)) {
      const rp = toRender(p);
      if (moveFrames) {
        // Editing a move: drag the "2" or the "1" frame (an empty 2 is picked by pressing it).
        for (const which of [2, 1] as const) {
          const f = which === 1 ? moveFrames.one : moveFrames.two;
          if (!inside(f.rect, rp)) continue;
          e.currentTarget.setPointerCapture(e.pointerId);
          const c = camCenterCss(f.rect);
          if (which === 2 && !moveFrames.picked) setPos(moveFrames.id, 2, { position: canvasPos(c) });
          setDrag({ kind: 'pos', id: moveFrames.id, which, offset: { x: c.x - p.x, y: c.y - p.y } });
          return;
        }
        if (s.tool === 'camera') {
          // Anywhere else: that is where the camera goes (2. konum).
          e.currentTarget.setPointerCapture(e.pointerId);
          setPos(moveFrames.id, 2, { position: canvasPos(p) });
          setDrag({ kind: 'pos', id: moveFrames.id, which: 2, offset: { x: 0, y: 0 } });
          return;
        }
      } else {
        // No move here yet: add one at the playhead; it starts where the camera is and goes to the pressed spot.
        e.currentTarget.setPointerCapture(e.pointerId);
        const cam = plan.camera;
        const c = cam && inside(cam.rect, rp) ? camCenterCss(cam.rect) : p;
        const r = addCameraMoveAt(s.project, s.playhead, { position: canvasPos(c) });
        if (!r) { store.notify(t("Burada yeni kamera hareketine yer yok.")); return; }
        store.apply(() => r.project);
        store.select({ kind: 'camera', id: r.id });
        setDrag({ kind: 'pos', id: r.id, which: 2, offset: { x: c.x - p.x, y: c.y - p.y } });
        return;
      }
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (s.tool === 'privacy') {
      setDrag({ kind: 'draw', start: p, current: p });
      return;
    }
    if (s.tool === 'magnifier') {
      // Works at the playhead like the zoom tool: adds a range there or selects the one already there.
      addMagnifierAt(store, s.playhead);
      return;
    }
    if (s.tool === 'zoom') {
      // Every press works at the playhead: a manual zoom already there is re-aimed at the
      // pressed point; otherwise a new 3 s zoom starts there. The tool stays on for the next one.
      const src = toSource(p);
      const pos = timelineToSource(s.project, s.playhead, layoutSegments(s.project));
      if (!src || !pos) return;
      const center = { x: Math.min(1, Math.max(0, src.x)), y: Math.min(1, Math.max(0, src.y)) };
      const here = s.project.zooms.find((z) => z.origin === 'manual' && z.recordingId === pos.recordingId && z.start <= pos.sourceTime && pos.sourceTime < z.end);
      if (here) {
        store.apply((pr) => updateZoom(pr, here.id, { center, mode: 'region' }));
        store.select({ kind: 'zoom', id: here.id });
        return;
      }
      const d = s.project.style.zoomDefaults;
      const end = Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3));
      if (end - pos.sourceTime < secondsToTicks(0.2)) { store.notify(t("Burada yeni zoom'a yer yok.")); return; }
      place(store, 'zooms', {
        recordingId: pos.recordingId, start: pos.sourceTime, end, origin: 'manual', mode: 'region',
        center, scale: d.scale, enter: d.enter, exit: d.exit,
      });
      return;
    }
    // Select tool: camera bubble drag?
    const cam = plan.camera;
    const rp = toRender(p);
    if (cam && rp.x >= cam.rect.x && rp.x <= cam.rect.x + cam.rect.w && rp.y >= cam.rect.y && rp.y <= cam.rect.y + cam.rect.h) {
      const sel = s.selection?.kind === 'camera' ? s.project.cameraLayouts.find((c) => c.id === s.selection!.id) : undefined;
      const activeItem = sel && plan.sourceTime !== null && plan.sourceTime >= sel.start && plan.sourceTime < sel.end ? sel : undefined;
      const v = activeVariant(s.project);
      setDrag({
        kind: 'camera', origin: p,
        position: { x: (cam.rect.x + cam.rect.w / 2) / plan.width, y: (cam.rect.y + cam.rect.h / 2) / plan.height },
        target: activeItem ? 'item' : v.cameraOverride ? 'variant' : 'style', itemId: activeItem?.id,
      });
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    const p = local(e);
    const s = store.getState();
    if (drag.kind === 'draw') {
      setDrag({ ...drag, current: p });
      return;
    }
    if (drag.kind === 'pos') {
      setPos(drag.id, drag.which, { position: canvasPos({ x: p.x + drag.offset.x, y: p.y + drag.offset.y }) });
      return;
    }
    if (drag.kind === 'possize') {
      const k = Math.hypot(p.x - drag.center.x, p.y - drag.center.y) / drag.dist0;
      setPos(drag.id, drag.which, { size: Math.min(0.95, Math.max(0.08, drag.size0 * k)) });
      return;
    }
    if (drag.kind === 'camera') {
      const dx = (p.x - drag.origin.x) / box.w;
      const dy = (p.y - drag.origin.y) / box.h;
      const position = { x: Math.min(1, Math.max(0, drag.position.x + dx)), y: Math.min(1, Math.max(0, drag.position.y + dy)) };
      if (drag.target === 'item' && drag.itemId) store.apply((pr) => updateCameraLayout(pr, drag.itemId!, { layout: { position } }), { coalesce: 'cam-drag' });
      else if (drag.target === 'variant') store.apply((pr) => updateVariant(pr, pr.activeVariantId, { cameraOverride: { position } }), { coalesce: 'cam-drag' });
      else store.apply((pr) => setStyle(pr, { camera: { position } }), { coalesce: 'cam-drag' });
      return;
    }
    if (drag.kind === 'privacy') {
      const a = toSource(drag.origin);
      const b = toSource(p);
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const r = { ...drag.region };
      const m = drag.mode;
      if (m === 'move') { r.x += dx; r.y += dy; }
      if (m.includes('w')) { r.x += dx; r.w -= dx; }
      if (m.includes('e')) r.w += dx;
      if (m.includes('n')) { r.y += dy; r.h -= dy; }
      if (m.includes('s')) r.h += dy;
      const region = clampRectTo01(normalizeRect(r));
      const item = s.project.privacy.find((x) => x.id === drag.id);
      if (!item || plan?.sourceTime == null) return;
      const t = plan.sourceTime;
      // Do not let the area slide onto another area that is hidden at the same time.
      const candidate = item.keyframes.length > 0
        ? { ...item, keyframes: [...item.keyframes.filter((k) => Math.abs(k.t - t) > secondsToTicks(1 / 60)), { t, region }] }
        : { ...item, region };
      if (conflictsFor(s.project, 'privacy', candidate).length > 0) return;
      if (item.keyframes.length > 0) {
        // Edit the keyframe at this time (or add one) so moving content can be followed.
        const kf = item.keyframes.filter((k) => Math.abs(k.t - t) > secondsToTicks(1 / 60));
        kf.push({ t, region });
        kf.sort((x, y) => x.t - y.t);
        store.apply((pr) => updatePrivacy(pr, drag.id, { keyframes: kf } as never), { coalesce: 'prv-drag' });
      } else {
        store.apply((pr) => updatePrivacy(pr, drag.id, { region }), { coalesce: 'prv-drag' });
      }
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const s = store.getState();
    if (drag.kind === 'draw') {
      const a = toSource(drag.start);
      const b = toSource(drag.current);
      const pos = timelineToSource(s.project, s.playhead, layoutSegments(s.project));
      if (a && b && pos && Math.abs(drag.current.x - drag.start.x) > 6 && Math.abs(drag.current.y - drag.start.y) > 6) {
        const region = clampRectTo01(normalizeRect({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }));
        const end = Math.min(pos.placement.segment.sourceEnd, pos.sourceTime + secondsToTicks(3));
        place(store, 'privacy', {
          recordingId: pos.recordingId, start: pos.sourceTime, end, origin: 'manual', region, keyframes: [],
          effect: { kind: 'frosted' }, cornerRadius: 0.12, padFrames: 2,
        });
      }
    }
    store.endGesture();
    setDrag(null);
  };

  const startPrivacyDrag = (e: RPointerEvent, mode: Extract<Drag, { kind: 'privacy' }>['mode']) => {
    if (!activePrivacy || plan?.sourceTime == null) return;
    e.stopPropagation();
    const overlay = (e.currentTarget as HTMLElement).closest('.preview-overlay') as HTMLElement;
    overlay.setPointerCapture(e.pointerId);
    const r = overlay.getBoundingClientRect();
    setDrag({ kind: 'privacy', id: activePrivacy.id, mode, origin: { x: e.clientX - r.left, y: e.clientY - r.top }, region: privacyRegionAt(activePrivacy, plan.sourceTime) });
  };

  const drawBox = drag?.kind === 'draw'
    ? { x: Math.min(drag.start.x, drag.current.x), y: Math.min(drag.start.y, drag.current.y), w: Math.abs(drag.current.x - drag.start.x), h: Math.abs(drag.current.y - drag.start.y) }
    : null;
  const selBox = privacyVisible && activePrivacy && sourceTime !== null ? regionCss(privacyRegionAt(activePrivacy, sourceTime)) : null;
  const empty = project.sequence.segments.length === 0;

  return (
    <div className="preview" ref={wrapRef}>
      <div className="preview-canvas" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        <div ref={hostRef} className="preview-canvas-host" />
        <div
          className={`preview-overlay tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {tool === 'camera' && !moveFrames && plan?.camera && (() => {
            const a = toCss({ x: plan.camera.rect.x, y: plan.camera.rect.y });
            const b = toCss({ x: plan.camera.rect.x + plan.camera.rect.w, y: plan.camera.rect.y + plan.camera.rect.h });
            return <div className="camera-box" style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y, borderRadius: camRadius(plan.camera) }} />;
          })()}
          {moveFrames && (() => {
            const css = (r: Rect) => { const a = toCss({ x: r.x, y: r.y }); const b = toCss({ x: r.x + r.w, y: r.y + r.h }); return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }; };
            const one = css(moveFrames.one.rect);
            const two = css(moveFrames.two.rect);
            // Arrow from the edge of 1 to the edge of 2.
            const c1 = { x: one.left + one.width / 2, y: one.top + one.height / 2 };
            const c2 = { x: two.left + two.width / 2, y: two.top + two.height / 2 };
            const len = Math.hypot(c2.x - c1.x, c2.y - c1.y);
            const r1 = Math.min(one.width, one.height) / 2 + 4;
            const r2 = Math.min(two.width, two.height) / 2 + 10;
            const ux = (c2.x - c1.x) / (len || 1);
            const uy = (c2.y - c1.y) / (len || 1);
            const tagBelow = (top: number) => (top < 34 ? ' is-below' : '');
            return (
              <>
                {len > r1 + r2 + 12 && (
                  <svg className="cam-path" width={box.w} height={box.h} aria-hidden="true">
                    <defs><marker id="cam-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" /></marker></defs>
                    <line x1={c1.x + ux * r1} y1={c1.y + uy * r1} x2={c2.x - ux * r2} y2={c2.y - uy * r2} markerEnd="url(#cam-arrow)" />
                  </svg>
                )}
                <div className="cam-frame is-one" style={{ ...one, borderRadius: camRadius(moveFrames.one) }}>
                  <span className={`cam-frame-tag${tagBelow(one.top)}`}><b>1</b>{placeName(moveFrames.p1)}</span>
                  <span className="camera-handle" title={t("Boyutu değiştir")} onPointerDown={(e) => startPosResize(e, 1)} />
                </div>
                <div className={`cam-frame is-two${moveFrames.picked ? '' : ' is-empty'}`} style={{ ...two, borderRadius: camRadius(moveFrames.two) }}>
                  {moveFrames.picked && moveFrames.p2
                    ? <span className={`cam-frame-tag${tagBelow(two.top)}`}><b>2</b>{placeName(moveFrames.p2)}</span>
                    : <span className="cam-slot-text"><b>2</b><span>{t("2. konumu seçin")}</span></span>}
                  <span className="camera-handle" title={t("Boyutu değiştir")} onPointerDown={(e) => startPosResize(e, 2)} />
                </div>
              </>
            );
          })()}
          {drawBox && <div className="draw-box" style={{ left: drawBox.x, top: drawBox.y, width: drawBox.w, height: drawBox.h }} />}
          {selBox && (
            <div className="privacy-box" style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h }} onPointerDown={(e) => startPrivacyDrag(e, 'move')}>
              {HANDLES.map((h) => <span key={h} className={`handle h-${h}`} onPointerDown={(e) => startPrivacyDrag(e, h)} />)}
            </div>
          )}
        </div>
      </div>
      {empty && <div className="preview-note">{t("Bu projede henüz kayıt yok.")}</div>}
      {error && <div className="preview-note is-error">{t("Önizleme hatası:")} {error}</div>}
    </div>
  );
}
