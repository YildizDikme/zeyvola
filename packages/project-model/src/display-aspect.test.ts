import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@zeyvola/timing';
import { addRecording, createProject, evaluate, parseProject, pictureAspect, serializeProject, type Recording } from './index';

/** A 4:3 display (1024×768) recorded by the browser path; the frames came back as 1024×576. */
function squeezed(displayAspect: number | undefined, crop?: Recording['capture']['crop']): Recording {
  return {
    id: 'r1', createdAt: '2026-11-13T00:00:00Z', duration: sec(10),
    sources: {
      screen: { kind: 'screen', file: 'media/r1/screen.webm', mime: 'video/webm', width: 1024, height: 576, ...(displayAspect ? { displayAspect } : {}), fps: 30, startOffset: 0, duration: sec(10) },
    },
    capture: { backend: 'web', platform: 'win32-x64', target: { kind: crop ? 'region' : 'display', label: 'Ekran', bounds: { x: 0, y: 0, w: 1024, h: 768 }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: true, ...(crop ? { crop } : {}) },
    syncOffsets: {}, markers: [],
  };
}

/** Shape of the drawn screen picture. With the default "source" frame mode it follows the source. */
function drawnAspect(r: Recording): number {
  const plan = evaluate(addRecording(createProject('T'), r), sec(1), { size: { width: 1920, height: 1080 } });
  const f = plan.screen!.frame;
  return f.w / f.h;
}

describe('displayAspect (distorted frames from the browser path)', () => {
  it('pictureAspect prefers the recorded display shape', () => {
    expect(pictureAspect({ kind: 'screen', file: 'x', mime: 'video/webm', width: 1024, height: 576, displayAspect: 4 / 3, startOffset: 0, duration: 1 })).toBeCloseTo(4 / 3);
    expect(pictureAspect({ kind: 'screen', file: 'x', mime: 'video/webm', width: 1024, height: 576, startOffset: 0, duration: 1 })).toBeCloseTo(16 / 9);
    expect(pictureAspect({ kind: 'screen', file: 'x', mime: 'video/webm', startOffset: 0, duration: 1 })).toBeNull();
    // Nonsense values never take over.
    expect(pictureAspect({ kind: 'screen', file: 'x', mime: 'video/webm', width: 16, height: 9, displayAspect: Number.NaN, startOffset: 0, duration: 1 })).toBeCloseTo(16 / 9);
  });

  it('evaluate draws the screen with the display shape, not the frames shape', () => {
    expect(drawnAspect(squeezed(4 / 3))).toBeCloseTo(4 / 3, 2);
    expect(drawnAspect(squeezed(undefined))).toBeCloseTo(16 / 9, 2);
  });

  it('a region keeps the shape of its part of the display', () => {
    // Left half of a 4:3 display: 512×768 points → 2:3.
    expect(drawnAspect(squeezed(4 / 3, { x: 0, y: 0, w: 0.5, h: 1 }))).toBeCloseTo(2 / 3, 2);
  });

  it('survives saving and opening; older projects without the field open unchanged', () => {
    const withField = addRecording(createProject('T'), squeezed(4 / 3));
    const reopened = parseProject(JSON.parse(serializeProject(withField)));
    expect(reopened.recordings.r1!.sources.screen!.displayAspect).toBeCloseTo(4 / 3);

    const old = addRecording(createProject('T'), squeezed(undefined));
    const oldReopened = parseProject(JSON.parse(serializeProject(old)));
    expect(oldReopened.recordings.r1!.sources.screen).toEqual(old.recordings.r1!.sources.screen);
    expect('displayAspect' in oldReopened.recordings.r1!.sources.screen!).toBe(false);
  });
});
