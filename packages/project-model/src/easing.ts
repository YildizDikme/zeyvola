import { secondsToTicks, type Ticks } from '@zeyvola/timing';

export type Easing =
  | { kind: 'preset'; name: 'smooth' | 'fast' }
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'spring'; zeta: number; omega: number }
  | { kind: 'linear' }
  | { kind: 'instant' };

export interface Transition {
  duration: Ticks;
  easing: Easing;
}

/** Our own preset curves (values chosen for this product, tuned by testing). */
export const PRESET_CURVES = {
  smooth: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
  fast: { x1: 0.25, y1: 0, x2: 0.1, y2: 1 },
} as const;

export const PRESET_DURATIONS: Record<'smooth' | 'fast', Ticks> = {
  smooth: secondsToTicks(0.9),
  fast: secondsToTicks(0.35),
};

export function presetTransition(name: 'smooth' | 'fast'): Transition {
  return { duration: PRESET_DURATIONS[name], easing: { kind: 'preset', name } };
}

/**
 * Cubic Bézier with endpoints (0,0) and (1,1). Solves x(s) = u with Newton's method,
 * falling back to bisection, then returns y(s).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  let s = u;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(s) - u;
    if (Math.abs(err) < 1e-7) return sampleY(s);
    const d = slopeX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let i = 0; i < 40; i++) {
    const x = sampleX(s);
    if (Math.abs(x - u) < 1e-7) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

/**
 * Damped harmonic oscillator step response, x(0) = 0 → 1, time-normalized so that
 * u = 1 corresponds to the moment the response settles within 0.1 %.
 */
export function springResponse(zeta: number, omega: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const settle = springSettleTime(zeta, omega);
  const t = u * settle;
  if (zeta >= 1) {
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
}

/** Seconds until the envelope stays within 0.1 % of the target. */
export function springSettleTime(zeta: number, omega: number): number {
  const z = Math.max(0.05, Math.min(zeta, 1));
  return Math.log(1000) / (z * omega) + (zeta >= 1 ? 2 / omega : 0);
}

export function applyEasing(e: Easing, u: number): number {
  const v = u <= 0 ? 0 : u >= 1 ? 1 : u;
  switch (e.kind) {
    case 'linear':
      return v;
    case 'instant':
      return v > 0 ? 1 : 0;
    case 'preset': {
      const c = PRESET_CURVES[e.name];
      return cubicBezier(c.x1, c.y1, c.x2, c.y2, v);
    }
    case 'bezier':
      return cubicBezier(e.x1, e.y1, e.x2, e.y2, v);
    case 'spring':
      return springResponse(e.zeta, e.omega, v);
  }
}

/** Normalized progress through a transition that starts at `start`. */
export function transitionProgress(t: Ticks, start: Ticks, tr: Transition): number {
  if (tr.easing.kind === 'instant' || tr.duration <= 0) return t >= start ? 1 : 0;
  return applyEasing(tr.easing, (t - start) / tr.duration);
}

export function effectiveDuration(tr: Transition): Ticks {
  return tr.easing.kind === 'instant' ? 0 : tr.duration;
}
