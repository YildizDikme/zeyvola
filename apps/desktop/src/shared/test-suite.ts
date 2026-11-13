/**
 * In-app test suites. Each one starts the real app with a temporary projects folder and
 * synthetic devices (never the user's projects or settings) and reports through `smoke:report`.
 *
 *   --smoke      self tests of the renderer stack (pnpm smoke)
 *   --perftest   timing of automatic zoom, playback and export (pnpm perftest)
 *   --uitest     the main flow driven through the interface (pnpm uitest)
 *   --docshots   screenshots for the README from the sample project (pnpm docshots)
 */
export type TestSuite = 'smoke' | 'perf' | 'ui' | 'docs';

const FLAGS: ReadonlyMap<string, TestSuite> = new Map([
  ['--smoke', 'smoke'],
  ['--perftest', 'perf'],
  ['--uitest', 'ui'],
  ['--docshots', 'docs'],
]);

/** The suite asked for on the command line, or null in normal use. The first flag wins. */
export function suiteFromArgv(argv: readonly string[]): TestSuite | null {
  for (const a of argv) {
    const s = FLAGS.get(a);
    if (s) return s;
  }
  return null;
}
