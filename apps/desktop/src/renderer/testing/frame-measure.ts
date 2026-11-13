/**
 * Measurements on one decoded frame (RGBA pixels), for the real screen recording test (uitest.ts):
 * where the click driver's known square is, the colour at a point, dark bands at the edges. Pure
 * functions, so they are unit tested with synthetic frames (frame-measure.test.ts); the test only
 * decodes the frame and hands the pixels over.
 *
 * The driver (tests/real-capture-web/windows-clicks.ps1) shows a 240 px square of one colour inside
 * a 20 px black frame, in the middle of the screen. A box only counts as that square when it is
 * filled with one colour, stays inside the search window, and has a dark ring around it: so a plain
 * area of colour (Windows CI run 8) or a shape of a test pattern on a coloured ground (run 9:
 * Chromium's fake capture device) is not taken for it.
 */
export interface Pixels { data: Uint8ClampedArray; width: number; height: number }
/** Box as fractions of the frame. */
export interface Box { fx: number; fy: number; fw: number; fh: number }
export interface SquareFound extends Box { rgb: [number, number, number]; fill: number; ring: number }
/** Why no square was taken (for the report). */
export interface SquareMissing { reason: string; rgb?: [number, number, number] }

/** Mean RGB of the size×size pixels around (cx, cy), given as fractions of the frame. */
export function meanColor(p: Pixels, cx: number, cy: number, size = 8): [number, number, number] {
  const mx = Math.round(cx * p.width);
  const my = Math.round(cy * p.height);
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = my - size / 2; y < my + size / 2; y++) {
    for (let x = mx - size / 2; x < mx + size / 2; x++) {
      if (x < 0 || y < 0 || x >= p.width || y >= p.height) continue;
      const i = (y * p.width + x) * 4;
      sum[0] += p.data[i]!; sum[1] += p.data[i + 1]!; sum[2] += p.data[i + 2]!;
      n++;
    }
  }
  return sum.map((s) => Math.round(s / Math.max(1, n))) as [number, number, number];
}

/** Sum of the absolute differences of the RGB channels (0…765). */
export const colorDistance = (a: readonly number[], b: readonly number[]): number => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);

/**
 * The square around an expected place: `near` gives its expected middle and size (fractions of the
 * frame); the search window is twice its size. The square's colour is taken from the frame itself
 * (its expected middle), so the shape can be measured even when the colours are wrong; the colour is
 * judged separately.
 */
export function findSquare(p: Pixels, near: { cx: number; cy: number; fw: number; fh: number }): SquareFound | SquareMissing {
  const { width: w, height: h, data: d } = p;
  const rgb = meanColor(p, near.cx, near.cy);
  // A square must stand out from its black frame; a near-black middle means it is not there.
  if (rgb[0] + rgb[1] + rgb[2] < 90) return { reason: 'beklenen yerin ortası koyu', rgb };
  const xa = Math.max(0, Math.floor((near.cx - near.fw) * w));
  const xb = Math.min(w - 1, Math.ceil((near.cx + near.fw) * w));
  const ya = Math.max(0, Math.floor((near.cy - near.fh) * h));
  const yb = Math.min(h - 1, Math.ceil((near.cy + near.fh) * h));
  const like = (x: number, y: number) => { const i = (y * w + x) * 4; return Math.abs(d[i]! - rgb[0]) + Math.abs(d[i + 1]! - rgb[1]) + Math.abs(d[i + 2]! - rgb[2]) < 90; };
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) if (like(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return { reason: 'renk bulunamadı', rgb };
  // Reaching the search window's edge: a plain area of that colour, not the square.
  if (x0 <= xa || x1 >= xb || y0 <= ya || y1 >= yb) return { reason: 'aynı renk arama penceresinin kenarına kadar sürüyor (düz alan)', rgb };
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 8 || bh < 8) return { reason: `çok küçük (${bw}×${bh} px)`, rgb };
  // Filled with that one colour (a disc, a wedge or an outline is not).
  let inside = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (like(x, y)) inside++;
  const fill = inside / (bw * bh);
  // And framed in black: a ring a few pixels outside the box (2 px of room for compression blur).
  const gap = 2;
  const ringW = Math.max(2, Math.round(0.04 * Math.min(bw, bh)));
  let ringN = 0;
  let ringDark = 0;
  for (let y = y0 - gap - ringW; y <= y1 + gap + ringW; y++) {
    for (let x = x0 - gap - ringW; x <= x1 + gap + ringW; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const out = x < x0 - gap || x > x1 + gap || y < y0 - gap || y > y1 + gap;
      if (!out) continue;
      const i = (y * w + x) * 4;
      ringN++;
      if (d[i]! + d[i + 1]! + d[i + 2]! < 120) ringDark++;
    }
  }
  const ring = ringN ? ringDark / ringN : 0;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  if (fill < 0.9) return { reason: `kutu tek renkle dolu değil (doluluk ${r2(fill)})`, rgb };
  if (ring < 0.9) return { reason: `çevresinde siyah çerçeve yok (koyu ${r2(ring)})`, rgb };
  return { fx: x0 / w, fy: y0 / h, fw: bw / w, fh: bh / h, rgb, fill: r2(fill), ring: r2(ring) };
}

export const isFound = (x: SquareFound | SquareMissing | null | undefined): x is SquareFound => !!x && 'fx' in x;

/** Uniform dark columns or rows at the frame's edges (letterbox/pillarbox), in pixels. */
export function darkBands(p: Pixels): { left: number; right: number; top: number; bottom: number } {
  const { width: w, height: h, data: d } = p;
  const dark = (x: number, y: number) => { const i = (y * w + x) * 4; return d[i]! + d[i + 1]! + d[i + 2]! < 24; };
  const col = (x: number) => { for (let y = 0; y < h; y += 4) if (!dark(x, y)) return false; return true; };
  const row = (y: number) => { for (let x = 0; x < w; x += 4) if (!dark(x, y)) return false; return true; };
  let left = 0; while (left < w / 2 && col(left)) left++;
  let right = 0; while (right < w / 2 && col(w - 1 - right)) right++;
  let top = 0; while (top < h / 2 && row(top)) top++;
  let bottom = 0; while (bottom < h / 2 && row(h - 1 - bottom)) bottom++;
  return { left, right, top, bottom };
}
