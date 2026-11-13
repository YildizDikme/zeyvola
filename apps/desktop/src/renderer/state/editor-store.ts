import { useSyncExternalStore } from 'react';
import {
  History, parseCursorLog, parseProject, prepareCursor, sequenceDuration, serializeProject,
  type ID, type PreparedCursor, type Project,
} from '@zeyvola/project-model';
import type { OpenedProject } from '@zeyvola/protocol';
import { clamp, type Ticks } from '@zeyvola/timing';
import { api } from '../api';
import { t } from '../i18n';

export type SelectionKind = 'zoom' | 'privacy' | 'camera' | 'magnifier' | 'segment';
export interface Selection {
  kind: SelectionKind;
  id: ID;
}

export type Tool = 'select' | 'privacy' | 'zoom' | 'cut' | 'camera' | 'magnifier';
export type InspectorTab = 'style' | 'camera' | 'cursor' | 'magnifier' | 'audio' | 'zoom';

export interface EditorState {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  playhead: Ticks;
  /**
   * The playhead as of the last time it stood still: equal to `playhead` while paused, and the
   * position playback started from while playing. Panels that only need to know "where am I
   * working" read this one, so they are not redrawn on every frame of playback.
   */
  settledPlayhead: Ticks;
  playing: boolean;
  selection: Selection | null;
  tool: Tool;
  tab: InspectorTab;
  save: 'saved' | 'pending' | 'saving' | 'error';
  saveError?: string;
  cursors: Record<ID, PreparedCursor | undefined>;
  mediaBase: string;
  /** Timeline zoom in pixels per second. */
  pxPerSecond: number;
  exportOpen: boolean;
  /** Short message shown when an action is refused (e.g. a placement rule). */
  notice: string | null;
}

const SAVE_DELAY = 1200;

/**
 * Editor state. The document lives in an undo history; every change is persisted
 * shortly after (atomic write in the main process). UI-only state is kept alongside.
 */
export class EditorStore {
  private history: History<Project>;
  private state: EditorState;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private lastSavedJson = '';

  constructor(opened: OpenedProject) {
    const project = parseProject(opened.json);
    this.history = new History(project);
    this.lastSavedJson = serializeProject(project, new Date(0));
    this.state = {
      project, canUndo: false, canRedo: false, playhead: 0, settledPlayhead: 0, playing: false, selection: null, tool: 'select', tab: 'style',
      save: 'saved', cursors: {}, mediaBase: opened.mediaBase, pxPerSecond: 48, exportOpen: false, notice: null,
    };
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getState = () => this.state;

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get project(): Project {
    return this.state.project;
  }

  /** Applies a pure command. Same coalesce key within a second → one undo step. */
  apply(fn: (p: Project) => Project, opts: { coalesce?: string } = {}): void {
    const next = fn(this.history.present);
    if (next === this.history.present) return;
    this.history.push(next, { coalesceKey: opts.coalesce });
    this.afterChange();
  }

  endGesture(): void {
    this.history.breakCoalescing();
  }

  undo(): void {
    if (this.history.undo()) this.afterChange();
  }

  redo(): void {
    if (this.history.redo()) this.afterChange();
  }

  private afterChange(): void {
    const project = this.history.present;
    const duration = sequenceDuration(project);
    const selection = this.state.selection && this.selectionExists(project, this.state.selection) ? this.state.selection : null;
    const playhead = clamp(this.state.playhead, 0, Math.max(0, duration - 1));
    this.set({
      project, canUndo: this.history.canUndo, canRedo: this.history.canRedo, selection,
      playhead, ...(this.state.playing ? {} : { settledPlayhead: playhead }), save: 'pending',
    });
    this.scheduleSave();
  }

  private selectionExists(p: Project, s: Selection): boolean {
    switch (s.kind) {
      case 'zoom': return p.zooms.some((z) => z.id === s.id);
      case 'privacy': return p.privacy.some((z) => z.id === s.id);
      case 'camera': return p.cameraLayouts.some((z) => z.id === s.id);
      case 'magnifier': return p.magnifiers.some((z) => z.id === s.id);
      case 'segment': return p.sequence.segments.some((z) => z.id === s.id);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const project = this.history.present;
    const json = serializeProject(project);
    const comparable = serializeProject(project, new Date(0));
    if (comparable === this.lastSavedJson) {
      if (this.state.save !== 'saved') this.set({ save: 'saved' });
      return;
    }
    this.set({ save: 'saving' });
    this.saving = this.saving.then(async () => {
      try {
        await api.saveProject(project.id, json);
        this.lastSavedJson = comparable;
        if (this.history.present === project) this.set({ save: 'saved', saveError: undefined });
      } catch (e) {
        this.set({ save: 'error', saveError: (e as Error).message });
      }
    });
    await this.saving;
  }

  setPlayhead(t: Ticks): void {
    const duration = sequenceDuration(this.history.present);
    const v = clamp(Math.round(t), 0, Math.max(0, duration - 1));
    if (v !== this.state.playhead) this.set({ playhead: v, ...(this.state.playing ? {} : { settledPlayhead: v }) });
  }

  setPlaying(playing: boolean): void {
    if (playing !== this.state.playing) this.set({ playing, settledPlayhead: this.state.playhead });
  }

  select(selection: Selection | null): void {
    this.set({ selection, ...(selection ? { tab: tabFor(selection.kind, this.state.tab) } : {}) });
  }

  setTool(tool: Tool): void {
    this.set({ tool });
  }

  setTab(tab: InspectorTab): void {
    this.set({ tab });
  }

  setPxPerSecond(v: number): void {
    this.set({ pxPerSecond: clamp(v, 4, 600) });
  }

  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  notify(notice: string, ms = 3200): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.set({ notice });
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), ms);
  }

  setExportOpen(open: boolean): void {
    this.set({ exportOpen: open });
  }

  /** Loads and prepares cursor logs (kept outside the document). */
  async loadCursors(): Promise<void> {
    const project = this.history.present;
    const cursors: Record<ID, PreparedCursor | undefined> = {};
    await Promise.all(Object.values(project.recordings).map(async (rec) => {
      if (!rec.cursorFile) return;
      try {
        const text = await api.readProjectText(project.id, rec.cursorFile);
        cursors[rec.id] = prepareCursor(parseCursorLog(text), 0.12 + project.style.cursor.smoothing * 0.25);
      } catch { /* missing log: cursor features off for this recording */ }
    }));
    this.set({ cursors });
  }

  rawCursorText = async (recordingId: ID): Promise<string | null> => {
    const rec = this.history.present.recordings[recordingId];
    if (!rec?.cursorFile) return null;
    try { return await api.readProjectText(this.history.present.id, rec.cursorFile); } catch { return null; }
  };
}

function tabFor(kind: SelectionKind, current: InspectorTab): InspectorTab {
  if (kind === 'zoom') return 'zoom';
  if (kind === 'camera') return 'camera';
  if (kind === 'magnifier') return 'magnifier';
  return current;
}

export function useEditor<T>(store: EditorStore, selector: (s: EditorState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
