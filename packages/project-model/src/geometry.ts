export interface Vec2 {
  x: number;
  y: number;
}

/** Axis-aligned rectangle. Units depend on context (normalized 0..1 or pixels). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export function lerpVec(a: Vec2, b: Vec2, u: number): Vec2 {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) };
}

/** Interpolates positive magnitudes multiplicatively so perceived speed stays even. */
export function logLerp(a: number, b: number, u: number): number {
  if (a <= 0 || b <= 0) return lerp(a, b, u);
  return Math.exp(lerp(Math.log(a), Math.log(b), u));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectFromCenter(c: Vec2, w: number, h: number): Rect {
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

export function lerpRect(a: Rect, b: Rect, u: number): Rect {
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function normalizeRect(r: Rect): Rect {
  const x = r.w < 0 ? r.x + r.w : r.x;
  const y = r.h < 0 ? r.y + r.h : r.y;
  return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) };
}

export function clampRectTo01(r: Rect): Rect {
  const x = Math.max(0, Math.min(1, r.x));
  const y = Math.max(0, Math.min(1, r.y));
  const w = Math.max(0, Math.min(1 - x, r.w));
  const h = Math.max(0, Math.min(1 - y, r.h));
  return { x, y, w, h };
}

/** Largest rect of aspect `aspect` (w/h) that fits inside `box`, centered. */
export function fitAspect(box: Rect, aspect: number): Rect {
  const boxAspect = box.w / box.h;
  if (boxAspect > aspect) {
    const w = box.h * aspect;
    return { x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h };
  }
  const h = box.w / aspect;
  return { x: box.x, y: box.y + (box.h - h) / 2, w: box.w, h };
}

export function pointInRect(p: Vec2, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
