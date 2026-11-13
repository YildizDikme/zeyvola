/**
 * Timing probe read by the performance test (testing/perf.ts). Off in normal use: every call
 * returns after one boolean check, so the measured code paths stay the ones users run.
 */
let on = false;
const series = new Map<string, number[]>();
const counts = new Map<string, number>();

export interface ProbeResult {
  /** Durations in milliseconds, by name. */
  series: Record<string, number[]>;
  counts: Record<string, number>;
}

export const probe = {
  get on(): boolean { return on; },
  start(): void {
    series.clear();
    counts.clear();
    on = true;
  },
  stop(): ProbeResult {
    on = false;
    return { series: Object.fromEntries(series), counts: Object.fromEntries(counts) };
  },
  /** Adds one duration to a series. */
  record(name: string, ms: number): void {
    if (!on) return;
    const list = series.get(name);
    if (list) list.push(ms);
    else series.set(name, [ms]);
  },
  count(name: string, by = 1): void {
    if (!on) return;
    counts.set(name, (counts.get(name) ?? 0) + by);
  },
};
