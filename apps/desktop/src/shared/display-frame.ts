/**
 * Frame size of the browser (getDisplayMedia) recording path.
 *
 * The Screen Capture specification lets the browser downscale a display surface but never
 * crop it, and requires the aspect ratio of the surface to be kept at all times (W3C Screen
 * Capture, "Downscaling and Frame Decimation"; docs/sources.md). Chromium on Windows was
 * measured breaking this: a 1024×768 display, asked for with ideal width 1024 and ideal height
 * 768, came back as 1024×576 frames with the 4:3 picture squeezed into them. So the size is
 * asked for with the display's aspect ratio as well, what comes back is checked and, if needed,
 * asked for again. Frames that keep the wrong shape are still recorded (on Windows this path is
 * the only one), and the source remembers the display's shape so the picture is drawn with it:
 * the squeeze is a scale along one axis, so it can be undone (with less detail on that axis).
 *
 * Pure: no DOM, no Electron. Used by the capture window (renderer/capture.ts) and by main
 * (main/capture/web-backend.ts), which stores the display shape with the source.
 */

export type CaptureTargetKind = 'display' | 'window' | 'region';

export interface PixelSize { width: number; height: number }

/** Two shapes differ by more than this (relative) → the picture would be visibly distorted. */
export const ASPECT_TOLERANCE = 0.01;

/**
 * Video constraints for getDisplayMedia. `display` is the display's size in device pixels.
 * Displays and regions (a region records its whole display, then crops) ask for the display's
 * size and shape. A window's shape is its own, so only the frame rate is asked for besides the
 * size limit; the browser then delivers the window as it is.
 */
export function displayVideoConstraints(kind: CaptureTargetKind, display: PixelSize, fps: number): MediaTrackConstraints {
  const frameRate = { ideal: fps, max: fps };
  if (kind === 'window') return { width: { ideal: display.width }, height: { ideal: display.height }, frameRate };
  return {
    width: { ideal: display.width },
    height: { ideal: display.height },
    aspectRatio: { ideal: display.width / display.height },
    frameRate,
  };
}

export type FrameCheck =
  | { ok: true }
  | { ok: false; expected: PixelSize; actual: PixelSize; /** actual aspect / expected aspect */ ratio: number };

/**
 * Whether frames of size `actual` show the display (`expected`, device pixels) undistorted.
 * Only the shape matters: a downscaled frame with the same shape is fine. Window recordings
 * are not checked (their shape is the window's). Unknown sizes pass: there is nothing to judge.
 */
export function checkFrame(kind: CaptureTargetKind, expected: PixelSize, actual: Partial<PixelSize>): FrameCheck {
  if (kind === 'window') return { ok: true };
  const w = actual.width ?? 0;
  const h = actual.height ?? 0;
  if (!(w > 0 && h > 0 && expected.width > 0 && expected.height > 0)) return { ok: true };
  const ratio = (w / h) / (expected.width / expected.height);
  // One pixel of rounding on either side is never a distortion, whatever the size.
  const slack = Math.max(ASPECT_TOLERANCE, 1 / w + 1 / h);
  return Math.abs(ratio - 1) <= slack ? { ok: true } : { ok: false, expected, actual: { width: w, height: h }, ratio };
}

/**
 * Constraint sets to try, in order, on a track whose frames came back with the wrong shape:
 * first the display's exact size, then only its exact shape (any size the browser offers).
 * Either may be refused (OverconstrainedError); the caller checks the frames after each.
 */
export function correctionConstraints(display: PixelSize, fps: number): MediaTrackConstraints[] {
  const frameRate = { ideal: fps, max: fps };
  return [
    { width: { exact: display.width }, height: { exact: display.height }, frameRate },
    { aspectRatio: { exact: display.width / display.height }, width: { max: display.width }, height: { max: display.height }, frameRate },
  ];
}

/**
 * The shape to store with a screen source (MediaSource.displayAspect) when its frames did not
 * come back with the display's shape even after the corrections; undefined when they did, for
 * windows, and when a size is unknown. `displayPoints` is the display (or, for a region, the
 * whole display) in points; only its shape is used.
 */
export function displayAspectFor(kind: CaptureTargetKind, displayPoints: PixelSize, frame: Partial<PixelSize>): number | undefined {
  const check = checkFrame(kind, displayPoints, frame);
  return check.ok ? undefined : displayPoints.width / displayPoints.height;
}
