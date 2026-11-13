import { describe, expect, it } from 'vitest';
import { checkFrame, correctionConstraints, displayAspectFor, displayVideoConstraints } from './display-frame';

describe('displayVideoConstraints', () => {
  it('asks for the display size and its shape for a display and a region', () => {
    for (const kind of ['display', 'region'] as const) {
      const c = displayVideoConstraints(kind, { width: 1024, height: 768 }, 30);
      expect(c.width).toEqual({ ideal: 1024 });
      expect(c.height).toEqual({ ideal: 768 });
      expect(c.aspectRatio).toEqual({ ideal: 4 / 3 });
      expect(c.frameRate).toEqual({ ideal: 30, max: 30 });
    }
  });

  it('keeps a window at its own shape (no aspect ratio asked for)', () => {
    const c = displayVideoConstraints('window', { width: 2880, height: 1800 }, 60);
    expect(c.aspectRatio).toBeUndefined();
    expect(c.frameRate).toEqual({ ideal: 60, max: 60 });
  });
});

describe('checkFrame', () => {
  const display = { width: 1024, height: 768 };

  it('catches the measured Windows case: a 4:3 display delivered as 1024×576', () => {
    const r = checkFrame('display', display, { width: 1024, height: 576 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.ratio).toBeCloseTo((16 / 9) / (4 / 3), 5);
    expect(checkFrame('region', display, { width: 1024, height: 576 }).ok).toBe(false);
  });

  it('accepts the native size and a downscale with the same shape', () => {
    expect(checkFrame('display', display, { width: 1024, height: 768 }).ok).toBe(true);
    expect(checkFrame('display', display, { width: 640, height: 480 }).ok).toBe(true);
    // Retina: asked for device pixels, delivered at half size.
    expect(checkFrame('display', { width: 3024, height: 1964 }, { width: 1512, height: 982 }).ok).toBe(true);
  });

  it('tolerates one pixel of rounding', () => {
    expect(checkFrame('display', { width: 1366, height: 768 }, { width: 683, height: 385 }).ok).toBe(true);
    expect(checkFrame('display', { width: 101, height: 75 }, { width: 100, height: 75 }).ok).toBe(true);
  });

  it('does not judge windows or unknown sizes', () => {
    expect(checkFrame('window', display, { width: 1024, height: 576 }).ok).toBe(true);
    expect(checkFrame('display', display, {}).ok).toBe(true);
    expect(checkFrame('display', display, { width: 0, height: 0 }).ok).toBe(true);
  });
});

describe('correctionConstraints', () => {
  it('tries no browser scaling first, then the exact size, then the exact shape', () => {
    const chain = correctionConstraints({ width: 1024, height: 768 }, 30);
    expect(chain.map((c) => c.name)).toEqual(['resize-none', 'exact-size', 'exact-aspect']);
    expect(chain[0]!.constraints).toEqual({ resizeMode: 'none', frameRate: { ideal: 30, max: 30 } });
    expect(chain[1]!.constraints).toMatchObject({ width: { exact: 1024 }, height: { exact: 768 } });
    expect(chain[2]!.constraints).toMatchObject({ aspectRatio: { exact: 4 / 3 } });
  });

  it('is not part of the first request: frames with the right shape keep the old constraints', () => {
    expect(displayVideoConstraints('display', { width: 1024, height: 768 }, 30).resizeMode).toBeUndefined();
  });
});

describe('displayAspectFor', () => {
  it('keeps the recording going with the display shape when the frames stay squeezed', () => {
    expect(displayAspectFor('display', { width: 1024, height: 768 }, { width: 1024, height: 576 })).toBeCloseTo(4 / 3);
    // A region records the whole display: the display's shape is stored, the crop is applied later.
    expect(displayAspectFor('region', { width: 1440, height: 900 }, { width: 1440, height: 810 })).toBeCloseTo(16 / 10);
  });

  it('stores nothing when the frames are fine, for windows and for unknown sizes', () => {
    expect(displayAspectFor('display', { width: 1024, height: 768 }, { width: 1024, height: 768 })).toBeUndefined();
    expect(displayAspectFor('display', { width: 1512, height: 982 }, { width: 3024, height: 1964 })).toBeUndefined();
    expect(displayAspectFor('window', { width: 1024, height: 768 }, { width: 1024, height: 576 })).toBeUndefined();
    expect(displayAspectFor('display', { width: 1024, height: 768 }, {})).toBeUndefined();
  });
});
