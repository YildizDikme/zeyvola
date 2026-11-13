import type { Rational, Ticks } from '@zeyvola/timing';
import type { Transition } from './easing';
import type { Rect, Vec2 } from './geometry';

export type ID = string;
/** CSS-style hex color, "#rrggbb". */
export type Hex = string;

export const SCHEMA_VERSION = 1;

// ─── Media and recordings ───────────────────────────────────────────────────

export type SourceKind = 'screen' | 'camera' | 'mic' | 'system';

export interface MediaSource {
  kind: SourceKind;
  /** Path relative to the project folder. */
  file: string;
  mime: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  /** When this source's first sample occurs, relative to recording start. */
  startOffset: Ticks;
  duration: Ticks;
}

/** 'import': a video added from the computer rather than recorded in the app. */
export type CaptureBackendId = 'native-macos' | 'native-windows' | 'web' | 'import';

export interface CaptureInfo {
  backend: CaptureBackendId;
  platform: string;
  target: {
    kind: 'display' | 'window' | 'region';
    label: string;
    /** Captured area in global desktop points. */
    bounds: Rect;
    scaleFactor: number;
  };
  /** True when the OS cursor is baked into the screen video (no separate cursor rendering). */
  cursorInFrames: boolean;
  /** True when click events were captured (enables click-driven zoom suggestions). */
  hasClicks: boolean;
  /**
   * Non-destructive crop (normalized to the screen video) used when the backend records
   * the whole display for a region capture. All screen-space coordinates (cursor, zoom,
   * privacy) are relative to this crop.
   */
  crop?: Rect;
}

export interface Recording {
  id: ID;
  createdAt: string;
  /** Length of the recording session (pauses removed). */
  duration: Ticks;
  sources: Partial<Record<SourceKind, MediaSource>>;
  /** Path of the cursor/event log relative to the project folder. */
  cursorFile?: string;
  capture: CaptureInfo;
  /** Manual per-source sync correction; positive delays the source. */
  syncOffsets: Partial<Record<SourceKind, Ticks>>;
  markers: Ticks[];
}

// ─── Timeline ───────────────────────────────────────────────────────────────

/** A contiguous range of one recording placed on the timeline. Cuts and splits live here. */
export interface Segment {
  id: ID;
  recordingId: ID;
  sourceStart: Ticks;
  sourceEnd: Ticks;
}

export interface Sequence {
  fps: Rational;
  segments: Segment[];
}

/** Effect items are anchored to recording (source) time so they follow content through edits. */
export interface ItemBase {
  id: ID;
  recordingId: ID;
  start: Ticks;
  end: Ticks;
  origin: 'auto' | 'manual';
}

export interface ZoomItem extends ItemBase {
  type: 'zoom';
  mode: 'region' | 'follow';
  /** Target center in normalized screen-source coordinates. */
  center: Vec2;
  /** Zoom factor relative to the fitted view (1 = no zoom). */
  scale: number;
  enter: Transition;
  exit: Transition;
  confidence?: number;
}

export type CameraShape = 'circle' | 'square' | 'rounded' | 'rect' | 'free' | 'squircle';

export interface CameraLayout {
  visible: boolean;
  /** Center of the camera bubble, normalized to the canvas. */
  position: Vec2;
  /** Height of the camera bubble as a fraction of canvas height. */
  size: number;
  shape: CameraShape;
  /** Width/height, used by 'rect' and 'free'. */
  aspect: number;
  /** Corner radius as a fraction of the shorter side (0..0.5). */
  cornerRadius: number;
  border: { width: number; color: Hex };
  shadow: { opacity: number; blur: number };
  mirror: boolean;
  /** Zoom inside the camera feed (≥ 1). */
  zoom: number;
}

export interface CameraLayoutItem extends ItemBase {
  type: 'camera';
  /** 1. konum: the camera's look in the first part of the range. */
  layout: CameraLayout;
  /** How the camera eases into the 1. konum, and later into the 2. konum. */
  enter: Transition;
  /** 2. konum: where the camera moves at `split` (shape and style stay those of the 1. konum). Unset until picked. */
  second?: { position: Vec2; size: number };
  /** When the camera heads for the 2. konum, as a fraction of the range (default 0.5). */
  split?: number;
}

export type PrivacyEffect =
  | { kind: 'solid'; color: Hex }
  | { kind: 'frosted' }
  | { kind: 'blur'; strength: number }
  | { kind: 'pixelate'; block: number };

export interface PrivacyKeyframe {
  t: Ticks;
  region: Rect;
}

export interface PrivacyItem extends ItemBase {
  type: 'privacy';
  /** Region in normalized screen-source coordinates. */
  region: Rect;
  keyframes: PrivacyKeyframe[];
  effect: PrivacyEffect;
  cornerRadius: number;
  /** Extra frames covered before start and after end ("hide when in doubt"). */
  padFrames: number;
}

// ─── Style and variants ─────────────────────────────────────────────────────

export type Background =
  | { kind: 'solid'; color: Hex }
  | { kind: 'gradient'; from: Hex; to: Hex; angle: number }
  | { kind: 'aurora'; colors: [Hex, Hex, Hex, Hex]; seed: number; grain: number }
  | { kind: 'image'; file: string; blur: number };

export interface FrameStyle {
  /** Padding around the screen as a fraction of the canvas's shorter side. */
  padding: number;
  /** Corner radius in pixels at 1080p; scaled with output size. */
  radius: number;
  shadow: { opacity: number; blur: number; offsetY: number };
  border: { width: number; color: Hex };
  /** 'source' keeps the recording's aspect; 'fill' uses the whole padded area and crops. */
  aspectMode: 'source' | 'fill';
  /** Canvas region (normalized) that holds the screen frame; the rest is free for the camera. */
  area: Rect;
}

export interface CursorStyle {
  visible: boolean;
  scale: number;
  /** 0 = raw, 1 = heavy smoothing. */
  smoothing: number;
  clickEffect: 'none' | 'ring' | 'pulse';
  hideWhenIdle: boolean;
}

/** A range in which a lens follows the cursor and magnifies the screen under it. */
export interface MagnifierItem extends ItemBase {
  type: 'magnifier';
  /** Lens width in pixels at 1080p; scaled with output size. */
  size: number;
  /** Magnification relative to the screen as shown in the frame (> 1). */
  zoom: number;
}

export type MagnifierShape = 'circle' | 'rounded';

/** Look shared by every magnifier range; `size` and `zoom` are what new ranges start with. */
export interface MagnifierStyle {
  size: number;
  zoom: number;
  shape: MagnifierShape;
  border: { width: number; color: Hex };
  hideWhenIdle: boolean;
}

export interface Style {
  background: Background;
  frame: FrameStyle;
  camera: CameraLayout;
  cursor: CursorStyle;
  magnifier: MagnifierStyle;
  zoomDefaults: { scale: number; enter: Transition; exit: Transition };
}

export interface Variant {
  id: ID;
  name: string;
  width: number;
  height: number;
  frameOverride?: Partial<FrameStyle>;
  cameraOverride?: Partial<CameraLayout>;
  /**
   * Scales zoom depth for this format (1 = as authored). Cropping formats like 9:16
   * are already tight, so they default lower.
   */
  zoomStrength?: number;
}

export interface AudioMix {
  mic: { gain: number; muted: boolean };
  system: { gain: number; muted: boolean };
}

export type ZoomSensitivity = 'low' | 'medium' | 'high';

export interface Project {
  schema: typeof SCHEMA_VERSION;
  id: ID;
  name: string;
  createdAt: string;
  updatedAt: string;
  recordings: Record<ID, Recording>;
  sequence: Sequence;
  zooms: ZoomItem[];
  cameraLayouts: CameraLayoutItem[];
  privacy: PrivacyItem[];
  magnifiers: MagnifierItem[];
  style: Style;
  variants: Variant[];
  activeVariantId: ID;
  audio: AudioMix;
  zoomEngine: { sensitivity: ZoomSensitivity; engineVersion?: string };
}

// ─── Cursor log (stored next to the media, not in project.json) ─────────────

export interface CursorSample {
  /** Recording time. */
  t: Ticks;
  /** Normalized to the captured area. May be outside 0..1 when the pointer leaves it. */
  x: number;
  y: number;
}

export interface ClickEvent {
  t: Ticks;
  x: number;
  y: number;
  button: 'left' | 'right' | 'other';
  kind: 'down' | 'up';
}

export interface ScrollEvent {
  t: Ticks;
  x: number;
  y: number;
  dy: number;
}

export interface CursorTrack {
  samples: CursorSample[];
  clicks: ClickEvent[];
  scrolls: ScrollEvent[];
}
