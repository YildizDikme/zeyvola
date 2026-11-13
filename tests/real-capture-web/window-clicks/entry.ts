// The app's own window-following code, wired the way web-backend.ts wires it for a window
// recording on macOS: the pointer helper with --window, the bounds timeline and the cursor log.
import { BoundsTimeline, CursorTracker } from '../../../apps/desktop/src/main/capture/cursor-tracker';
import { InputHelper, inputHelperArgs, windowIdOf, type PointerEvent, type WindowBoundsEvent } from '../../../apps/desktop/src/main/capture/input-helper';
import { SessionClock } from '../../../apps/desktop/src/main/capture/session-clock';

export async function startTracking(o: { sourceId: string; helperPath: string; cursorFile: string }) {
  const windowId = windowIdOf(o.sourceId);
  if (windowId === null) throw new Error(`not a window source: ${o.sourceId}`);
  const clock = new SessionClock();
  const area = new BoundsTimeline();
  const reports: WindowBoundsEvent[] = [];
  const input = new InputHelper(o.helperPath, undefined, inputHelperArgs(windowId, 'darwin'));
  let tracker: CursorTracker | null = null;
  input.on('window', (ev: WindowBoundsEvent) => { reports.push(ev); area.set(ev.bounds, ev.atMs); });
  input.on('event', (ev: PointerEvent) => { if (tracker && ev.atMs >= clock.startedAt) tracker.writeInput(ev); });
  if (!(await input.start())) throw new Error('pointer helper did not start');
  if (!area.known) throw new Error('window bounds unknown at start');
  clock.start();
  tracker = new CursorTracker(clock, area);
  tracker.start(o.cursorFile);
  return {
    startedAt: clock.startedAt,
    reports,
    async stop() { await input.stop(); await tracker?.stop(); },
  };
}
