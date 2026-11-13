// The known-square search of the real screen recording test, on synthetic frames shaped like what
// the Windows runner showed: the real desktop with the driver's square, the plain area of run 8 and
// Chromium's fake capture pattern of run 9 (a wedge on green), which must not be taken for the square.
import { describe, expect, it } from 'vitest';
import { colorDistance, darkBands, findSquare, isFound, meanColor, type Pixels } from './frame-measure';

type RGB = [number, number, number];
function frame(w: number, h: number, paint: (x: number, y: number) => RGB): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = paint(x, y); const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; }
  return { data, width: w, height: h };
}
// A busy desktop: blue-grey ground with light "text" stripes, a bit of noise.
const noise = (x: number, y: number) => ((x * 7919 + y * 104729) % 17) - 8;
const desktop = (x: number, y: number): RGB => (y % 14 < 2 && x % 90 < 60 ? [220 + noise(x, y), 220, 220] : [40 + noise(x, y), 70, 110 + noise(y, x)]);
/** The driver's square on a 1024×768 screen drawn into a w×h frame (stretched to fill it). */
function withSquare(w: number, h: number, colour: RGB, ground = desktop, framed = true): { p: Pixels; near: { cx: number; cy: number; fw: number; fh: number }; box: { fx: number; fy: number; fw: number; fh: number } } {
  const sx = w / 1024;
  const sy = h / 768;
  const sq = { x: 392, y: 264, s: 240 };
  const p = frame(w, h, (x, y) => {
    const X = x / sx;
    const Y = y / sy;
    if (X >= sq.x && X < sq.x + sq.s && Y >= sq.y && Y < sq.y + sq.s) return [colour[0] + noise(x, y), colour[1], colour[2] + noise(y, x)];
    if (framed && X >= sq.x - 20 && X < sq.x + sq.s + 20 && Y >= sq.y - 20 && Y < sq.y + sq.s + 20) return [4, 4, 4];
    return ground(x, y);
  });
  const fw = 240 / 1024;
  const fh = 240 / 768;
  return { p, near: { cx: 0.5, cy: 0.5, fw, fh }, box: { fx: 392 / 1024, fy: 264 / 768, fw, fh } };
}

describe('findSquare', () => {
  it('finds the driver square on a desktop in a frame of the screen\'s shape, at its place and size', () => {
    const { p, near, box } = withSquare(1024, 768, [255, 0, 255]);
    const f = findSquare(p, near);
    expect(isFound(f)).toBe(true);
    if (!isFound(f)) return;
    for (const k of ['fx', 'fy', 'fw', 'fh'] as const) expect(Math.abs(f[k] - box[k])).toBeLessThan(0.012);
    expect(colorDistance(f.rgb, [255, 0, 255])).toBeLessThan(60);
    expect((f.fw * p.width) / (f.fh * p.height)).toBeCloseTo(1, 1);
  });

  it('measures a 4:3 screen stretched into 960×540 as stretched (1.33), with the same fractions', () => {
    const { p, near, box } = withSquare(960, 540, [255, 0, 255]);
    const f = findSquare(p, near);
    expect(isFound(f)).toBe(true);
    if (!isFound(f)) return;
    expect(Math.abs(f.fx - box.fx)).toBeLessThan(0.012);
    expect((f.fw * 960) / (f.fh * 540)).toBeCloseTo(4 / 3, 1);
  });

  it('still measures the shape when the colours are wrong (the colour is judged on its own)', () => {
    const { p, near } = withSquare(1024, 768, [9, 155, 2]);
    const f = findSquare(p, near);
    expect(isFound(f)).toBe(true);
    if (isFound(f)) expect(colorDistance(f.rgb, [255, 0, 255])).toBeGreaterThan(60);
  });

  it('does not take a plain area of colour for the square (run 8)', () => {
    const p = frame(960, 540, () => [9, 155, 2]);
    const f = findSquare(p, { cx: 0.5, cy: 0.5, fw: 0.234, fh: 0.3125 });
    expect(isFound(f)).toBe(false);
  });

  it('does not take the fake capture pattern\'s wedge on green for the square (run 9)', () => {
    // Green ground, a light green wedge (quarter disc) in the middle, light green corner squares.
    const p = frame(960, 540, (x, y) => {
      const dx = x - 480;
      const dy = y - 270;
      if (Math.hypot(dx, dy) < 90 && dx > -10 && dy < 10 && dy > -Math.abs(dx)) return [100, 255, 30];
      if ((x < 60 || x > 900) && (y < 60 || y > 480)) return [100, 255, 30];
      return [0, 128, 0];
    });
    const f = findSquare(p, { cx: 0.5, cy: 0.5, fw: 0.234, fh: 0.3125 });
    expect(isFound(f)).toBe(false);
  });

  it('wants the black frame: a magenta square straight on the desktop is not the driver\'s', () => {
    const { p, near } = withSquare(1024, 768, [255, 0, 255], desktop, false);
    expect(isFound(findSquare(p, near))).toBe(false);
  });

  it('finds nothing when the middle is dark (the square not in the picture)', () => {
    const p = frame(640, 360, () => [3, 3, 3]);
    const f = findSquare(p, { cx: 0.5, cy: 0.5, fw: 0.2, fh: 0.3 });
    expect(isFound(f)).toBe(false);
    if (!isFound(f)) expect(f.reason).toContain('koyu');
  });
});

describe('meanColor and darkBands', () => {
  it('reads the colour at a point and the black bands of a 4:3 picture in a 16:9 frame', () => {
    const p = frame(320, 180, (x) => (x < 40 || x >= 280 ? [0, 0, 0] : [200, 10, 30]));
    expect(meanColor(p, 0.5, 0.5)).toEqual([200, 10, 30]);
    expect(darkBands(p)).toEqual({ left: 40, right: 40, top: 0, bottom: 0 });
  });
});
