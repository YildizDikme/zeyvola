import { layoutSegments, sequenceDuration, timelineToSource, type ID, type Project, type Recording, type SegmentPlacement, type SourceKind } from '@zeyvola/project-model';
import { TICKS_PER_SECOND, type Ticks } from '@zeyvola/timing';
import type { EditorStore } from '../state/editor-store';
import { probe } from '../perf-probe';

export interface RecordingMedia {
  screen?: HTMLVideoElement;
  camera?: HTMLVideoElement;
  mic?: HTMLAudioElement;
  system?: HTMLAudioElement;
}

const KINDS = ['screen', 'camera', 'mic', 'system'] as const;
/** The element the clock follows, in order of preference: sound first, a glitch there is heard. */
const MASTER_ORDER = ['mic', 'system', 'screen', 'camera'] as const;

const DRIFT_PAUSED = 0.0005; // s; a paused element further off than this is put on the frame
const CUE_TIMEOUT = 2500; // ms to wait for the elements before playing on without them
const START_TIMEOUT = 600; // ms to wait for the sound to start coming out before starting the pictures anyway
/**
 * s of progress after which the sound counts as started. Its time first creeps ~15 ms ahead and
 * then stands still until the output really runs (~100 ms on macOS), so a smaller step is no proof.
 */
const START_MOVE = 0.05;
const SOFT_DRIFT = 0.012; // s; below this an element is simply in sync
const HARD_DRIFT = 0.35; // s; beyond this an element is re-positioned instead of nudged
const RESEEK_EVERY = 1500; // ms; an element is not re-positioned more often than this
const PICTURE_NUDGE = 0.2; // largest playback rate change used to pull a picture back in sync (not visible)
const SOUND_NUDGE = 0.05; // the same for sound, which is changed only when clearly off (audible)

export function mediaTime(rec: Recording, kind: SourceKind, sourceTime: Ticks): number {
  const src = rec.sources[kind];
  if (!src) return 0;
  return Math.max(0, (sourceTime - src.startOffset - (rec.syncOffsets[kind] ?? 0)) / TICKS_PER_SECOND);
}

/** An element that is playing and has data for the moment after the current one. */
const isSound = (kind: SourceKind) => kind === 'mic' || kind === 'system';
/**
 * Where an element should be for media time `want`. Tracks differ slightly in length and the
 * timeline may run past the end of a file; asking for a time past the end makes the element
 * clamp it, and the next check would ask again (an endless series of seeks while paused).
 */
const target = (el: HTMLMediaElement, want: number) => (Number.isFinite(el.duration) ? Math.min(want, el.duration) : want);
const flowing = (el: HTMLMediaElement) => !el.paused && !el.seeking && el.readyState >= 3 && !el.ended;
/** An element whose file has run out before the timeline did (tracks differ slightly in length). */
const exhausted = (el: HTMLMediaElement, want: number) => el.ended || (Number.isFinite(el.duration) && want >= el.duration - 0.02);

/**
 * Preview playback: one hidden media element per source.
 *
 * Paused, every element of the recording under the playhead sits on the playhead's frame.
 *
 * Playing, the elements run on their own and the timeline clock follows the one that carries
 * the sound (or the screen picture when there is no sound). The clock is never used to chase
 * an element with seeks: a seek interrupts sound and picture, and in files without a seek
 * index (the Chromium recording path writes those) it takes longer than the drift it is meant
 * to cure, so chasing never ends. Instead
 *   - at the start and at every cut the elements are positioned once, and the clock waits
 *     until they have a frame there;
 *   - while an element is waiting for data, the clock waits with it;
 *   - the other elements are kept on the clock by small playback-rate changes, and are
 *     re-positioned only when far off, at most once every RESEEK_EVERY.
 */
export class Player {
  private media = new Map<ID, RecordingMedia>();
  private raf = 0;
  /** Bumped by every play/pause; a frame callback of an earlier run stops on its own. */
  private run = 0;
  private clockStart = 0;
  private clockOrigin = 0;
  private frameListeners = new Set<() => void>();
  private unsub: () => void;
  private lastProject: Project | null = null;
  private placements: SegmentPlacement[] = [];
  /** Segment being played; a change means a cut was crossed. */
  private segmentId: ID | null = null;
  /**
   * Set while playback is being (re)started at a point (start, resume, a cut): first the elements
   * are positioned; then the leading element is started alone (`started`) and the clock waits
   * until its time moves. Sound output takes ~100 ms to start; a picture started together with
   * it would run that much ahead of the sound and the clock.
   */
  private cueing: { since: number; until: number; started?: { el: HTMLMediaElement; want: number; picture: boolean } } | null = null;
  private lastSeek = new WeakMap<HTMLMediaElement, number>();
  /** Timeline time shown on the last step. */
  private shown: Ticks = 0;

  constructor(private readonly store: EditorStore) {
    this.sync(store.project);
    this.unsub = store.subscribe(() => {
      const s = store.getState();
      if (s.project !== this.lastProject) this.sync(s.project);
      if (!s.playing) this.positionPaused(s.playhead);
    });
  }

  /** Called whenever a new decoded frame may be visible. */
  onFrame(fn: () => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private emitFrame(): void {
    for (const f of this.frameListeners) f();
  }

  elementsFor(recordingId: ID): RecordingMedia | undefined {
    return this.media.get(recordingId);
  }

  private sync(project: Project): void {
    this.lastProject = project;
    this.placements = layoutSegments(project);
    const base = this.store.getState().mediaBase;
    for (const rec of Object.values(project.recordings)) {
      let m = this.media.get(rec.id);
      if (!m) {
        m = {};
        this.media.set(rec.id, m);
        for (const kind of KINDS) {
          const src = rec.sources[kind];
          if (!src) continue;
          const el = document.createElement(kind === 'screen' || kind === 'camera' ? 'video' : 'audio') as HTMLVideoElement;
          el.crossOrigin = 'anonymous';
          el.preload = 'auto';
          el.playsInline = true;
          el.muted = kind === 'screen' || kind === 'camera';
          el.src = base + src.file.split('/').map(encodeURIComponent).join('/');
          const notify = () => this.emitFrame();
          el.addEventListener('seeked', notify);
          el.addEventListener('loadeddata', notify);
          el.addEventListener('seeking', () => probe.count(`seek:${kind}`));
          // The playhead may have been set before the file's metadata arrived.
          el.addEventListener('loadedmetadata', () => { if (!this.store.getState().playing) this.positionPaused(this.store.getState().playhead); });
          m[kind] = el;
        }
      }
      if (m.mic) {
        m.mic.volume = Math.min(1, project.audio.mic.gain);
        m.mic.muted = project.audio.mic.muted;
      }
      if (m.system) {
        m.system.volume = Math.min(1, project.audio.system.gain);
        m.system.muted = project.audio.system.muted;
      }
    }
  }

  /** Elements of the recording at timeline time `t` with the media time each should show; the rest are paused. */
  private active(t: Ticks): { segmentId: ID; rec: Recording; items: { kind: SourceKind; el: HTMLMediaElement; want: number }[] } | null {
    const project = this.store.project;
    const pos = timelineToSource(project, t, this.placements);
    const rec = pos ? project.recordings[pos.recordingId] : undefined;
    for (const [recId, m] of this.media) {
      if (rec && recId === rec.id) continue;
      for (const kind of KINDS) { const el = m[kind]; if (el && !el.paused) el.pause(); }
    }
    if (!pos || !rec) return null;
    const m = this.media.get(rec.id);
    const items: { kind: SourceKind; el: HTMLMediaElement; want: number }[] = [];
    for (const kind of KINDS) {
      const el = m?.[kind];
      if (el) items.push({ kind, el, want: mediaTime(rec, kind, pos.sourceTime) });
    }
    return { segmentId: pos.placement.segment.id, rec, items };
  }

  private seek(el: HTMLMediaElement, to: number, now = performance.now()): void {
    this.lastSeek.set(el, now);
    el.currentTime = to;
  }

  /** Paused: every element on the playhead's frame. */
  private positionPaused(t: Ticks): void {
    const a = this.active(t);
    if (!a) return;
    for (const { el, want } of a.items) {
      if (!el.paused) el.pause();
      if (el.playbackRate !== 1) el.playbackRate = 1;
      const to = target(el, want);
      if (Math.abs(el.currentTime - to) > DRIFT_PAUSED && el.readyState >= 1) el.currentTime = to;
    }
  }

  /**
   * Positions the elements for timeline time `t` and holds the clock there until they play.
   * Pictures are paused until the sound is under way (cueReady). At a cut (`running`) the sound
   * keeps playing through its seek, which saves part of its start-up delay.
   */
  private cue(t: Ticks, now: number, running = false): void {
    const a = this.active(t);
    this.segmentId = a?.segmentId ?? null;
    this.clockOrigin = t;
    this.clockStart = now;
    this.cueing = { since: now, until: now + CUE_TIMEOUT };
    if (!a) return;
    for (const { kind, el, want } of a.items) {
      if (!el.paused && !(running && isSound(kind))) el.pause();
      if (el.playbackRate !== 1) el.playbackRate = 1;
      const to = target(el, want);
      if (el.readyState >= 1 && Math.abs(el.currentTime - to) > DRIFT_PAUSED) this.seek(el, to, now);
    }
  }

  /**
   * One step of (re)starting at the cue point `t`. True once everything plays; the clock then
   * continues from `clockOrigin`, which is moved to where the leading element really is.
   */
  private cueReady(t: Ticks, now: number): boolean {
    const cue = this.cueing;
    const a = this.active(t);
    if (!a || !cue) return true;
    const live = a.items.filter((i) => !exhausted(i.el, i.want));
    const play = (el: HTMLMediaElement) => { if (el.paused) void el.play().catch(() => undefined); };
    if (!cue.started) {
      for (const { el, want } of live) {
        // Metadata arrived after the cue: put the element on the cue point once.
        if (el.readyState >= 1 && !el.seeking && Math.abs(el.currentTime - want) > 0.02 && (this.lastSeek.get(el) ?? 0) < cue.since) this.seek(el, target(el, want), now);
      }
      const ready = live.every((i) => !i.el.seeking && i.el.readyState >= 3);
      if (!ready && now < cue.until) return false;
      const master = MASTER_ORDER.map((k) => live.find((i) => i.kind === k)).find((i) => !!i);
      if (!master) return true;
      cue.started = { el: master.el, want: master.want, picture: !isSound(master.kind) };
      cue.until = now + START_TIMEOUT;
      play(master.el);
      if (!cue.started.picture) return false;
    }
    const st = cue.started;
    if (!st.picture) {
      // The sound's time moves steadily only once it is really coming out.
      const moved = st.el.currentTime - st.want;
      if (moved < START_MOVE && !st.el.ended && now < cue.until) return false;
      this.clockOrigin = t + Math.max(0, Math.min(0.2, moved)) * TICKS_PER_SECOND;
      this.clockStart = now;
    }
    for (const { el } of live) play(el);
    return true;
  }

  /** One step of playback: returns the timeline time to show. */
  private advance(now: number): Ticks {
    let t = this.clockOrigin + ((now - this.clockStart) / 1000) * TICKS_PER_SECOND;
    if (this.cueing) {
      // Hold the clock at the cue point until the elements have a frame there and play.
      t = this.clockOrigin;
      this.clockStart = now;
      if (!this.cueReady(t, now)) return t;
      this.cueing = null;
      return this.clockOrigin;
    }
    const a = this.active(t);
    if (!a) return t;
    if (a.segmentId !== this.segmentId) {
      // Crossed a cut: the next clip starts somewhere else in its recording.
      const start = this.placements.find((p) => p.segment.id === a.segmentId)?.timelineStart ?? t;
      this.cue(Math.max(start, Math.min(t, start + TICKS_PER_SECOND / 10)), now, true);
      return this.clockOrigin;
    }
    const live = a.items.filter((i) => !exhausted(i.el, i.want));
    const master = MASTER_ORDER.map((k) => live.find((i) => i.kind === k)).find((i) => !!i);
    if (!master) return t;
    if (master.el.paused) void master.el.play().catch(() => undefined);
    if (!flowing(master.el)) {
      // The leading element waits for data: the clock waits with it instead of running ahead.
      probe.count('clock-hold');
      this.clockOrigin = this.shown;
      this.clockStart = now;
      return this.shown;
    }
    // Follow the leading element: its own time is the truth, the clock only smooths it.
    const lead = master.el.currentTime - master.want; // s; > 0 when the element is ahead of the clock
    if (Math.abs(lead) > HARD_DRIFT) this.clockOrigin += lead * TICKS_PER_SECOND;
    else if (Math.abs(lead) > 0.004) this.clockOrigin += lead * TICKS_PER_SECOND * 0.06;
    t = this.clockOrigin + ((now - this.clockStart) / 1000) * TICKS_PER_SECOND;

    for (const i of live) {
      if (i === master) continue;
      const { el } = i;
      if (el.paused) void el.play().catch(() => undefined);
      if (el.seeking || el.readyState < 2) continue;
      const off = el.currentTime - i.want; // s; > 0 when this element is ahead
      if (Math.abs(off) > HARD_DRIFT) {
        if (now - (this.lastSeek.get(el) ?? 0) > RESEEK_EVERY) this.seek(el, i.want, now);
        continue;
      }
      // Pictures are pulled back with a small speed change; sound keeps its speed (a speed
      // change is audible) unless it is clearly off.
      const picture = i.kind === 'screen' || i.kind === 'camera';
      const max = picture ? PICTURE_NUDGE : SOUND_NUDGE;
      const rate = Math.abs(off) < (picture ? SOFT_DRIFT : 0.06) ? 1 : Math.min(1 + max, Math.max(1 - max, 1 - off * (picture ? 3 : 0.8)));
      if (Math.abs(el.playbackRate - rate) > 0.004) el.playbackRate = rate;
    }
    return t;
  }

  play(): void {
    const s = this.store.getState();
    const duration = sequenceDuration(s.project);
    if (duration <= 0 || s.playing) return;
    if (s.playhead >= duration - TICKS_PER_SECOND / 30) this.store.setPlayhead(0);
    this.store.setPlaying(true);
    this.cue(this.store.getState().playhead, performance.now());
    this.shown = this.clockOrigin;
    const run = ++this.run;
    const loop = () => {
      if (run !== this.run) return;
      const now = performance.now();
      const t = this.advance(now);
      this.shown = t;
      const end = sequenceDuration(this.store.project);
      if (t >= end) {
        this.store.setPlayhead(end - 1);
        this.pause();
        return;
      }
      this.store.setPlayhead(t);
      if (run !== this.run) return; // paused (or restarted) by a listener of the playhead
      this.emitFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause(): void {
    this.run++;
    cancelAnimationFrame(this.raf);
    this.cueing = null;
    this.segmentId = null;
    this.store.setPlaying(false);
    this.positionPaused(this.store.getState().playhead);
    this.emitFrame();
  }

  toggle(): void {
    if (this.store.getState().playing) this.pause();
    else this.play();
  }

  dispose(): void {
    this.run++;
    cancelAnimationFrame(this.raf);
    this.unsub();
    for (const m of this.media.values()) {
      for (const el of Object.values(m) as HTMLMediaElement[]) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
    }
    this.media.clear();
  }
}
