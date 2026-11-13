// Audit: a complex project survives save → reopen unchanged and renders identically.
// Run: npx vitest run --config tests/audit/vitest.audit.config.ts
import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '../../packages/timing/src/index.ts';
import {
  addCameraMoveAt, addPrivacy, addRecording, addZoom, createProject, evaluate, parseProject, presetTransition, removeSegment,
  serializeProject, setCameraMovePosition, splitAt, type Project,
} from '../../packages/project-model/src/index.ts';

const rec = (id: string, d: number, camera: boolean, backend: 'web' | 'import' = 'web') => ({
  id, createdAt: '2026-10-17T00:00:00Z', duration: sec(d),
  sources: {
    screen: { kind: 'screen' as const, file: `media/${id}/s.mp4`, mime: 'video/mp4', width: 1920, height: 1080, startOffset: 0, duration: sec(d) },
    ...(camera ? { camera: { kind: 'camera' as const, file: `media/${id}/c.mp4`, mime: 'video/mp4', width: 1280, height: 720, startOffset: 0, duration: sec(d) } } : {}),
    ...(backend === 'import' ? { system: { kind: 'system' as const, file: `media/${id}/s.mp4`, mime: 'video/mp4', startOffset: 0, duration: sec(d) } } : {}),
  },
  capture: { backend, platform: 't', target: { kind: 'display' as const, label: 'x', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 2 }, cursorInFrames: true, hasClicks: false },
  syncOffsets: { camera: sec(0.04) }, markers: [sec(3)],
});

describe('audit: save and reopen a complex project', () => {
  it('keeps every edit and renders identically after a JSON round trip', () => {
    let p: Project = addRecording(createProject('Denetim — ğüşiöç'), rec('rec_a', 20, true));
    p = addRecording(p, rec('imp_0123456789ab', 5, false, 'import'));
    p = addZoom(p, { recordingId: 'rec_a', start: sec(1), end: sec(4), origin: 'manual', mode: 'region', center: { x: 0.3, y: 0.4 }, scale: 2, enter: presetTransition('smooth'), exit: presetTransition('fast') }).project;
    const m = addCameraMoveAt(p, sec(6), { position: { x: 0.2, y: 0.2 }, size: 0.4 })!;
    p = setCameraMovePosition(m.project, m.id, 1, { position: { x: 0.85, y: 0.8 } });
    p = { ...p, cameraLayouts: p.cameraLayouts.map((c) => ({ ...c, split: 0.3 })) };
    p = addPrivacy(p, { recordingId: 'rec_a', start: sec(8), end: sec(12), origin: 'manual', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      keyframes: [{ t: sec(8), region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }, { t: sec(12), region: { x: 0.5, y: 0.6, w: 0.2, h: 0.1 } }],
      effect: { kind: 'solid', color: '#000000' }, cornerRadius: 0.1, padFrames: 2 }).project;
    p = splitAt(p, sec(10));
    p = splitAt(p, sec(11));
    p = removeSegment(p, p.sequence.segments[1]!.id);
    const back = parseProject(JSON.parse(serializeProject(p)));
    const flat = (o: unknown, pre = '', out: Record<string, string> = {}) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flat(v, pre ? `${pre}.${k}` : k, out);
      else out[pre] = JSON.stringify(o);
      return out;
    };
    const fa = flat(p); const fb = flat(back);
    const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
    const diffs = [...keys].filter((k) => k !== 'updatedAt' && fa[k] !== fb[k]).map((k) => `${k}: kaydedilen=${fa[k]} açılan=${fb[k]}`);
    console.log('DIFFS', diffs.length, '\n' + diffs.slice(0, 40).join('\n'));
    expect(diffs).toEqual([]);
    for (const t of [0.5, 2, 6.5, 8.5, 9.9, 10.5, 12, 19.5, 21]) {
      expect(JSON.stringify(evaluate(back, sec(t)))).toBe(JSON.stringify(evaluate(p, sec(t))));
    }
  });
});
