import { describe, expect, it } from 'vitest';
import { suiteFromArgv } from './test-suite';

describe('suiteFromArgv', () => {
  it('returns null in normal use', () => {
    expect(suiteFromArgv([])).toBeNull();
    expect(suiteFromArgv(['/Applications/Zeyvola.app/Contents/MacOS/Zeyvola', '--some-chromium-switch'])).toBeNull();
  });

  it('maps each flag to its suite', () => {
    expect(suiteFromArgv(['electron', '.', '--smoke'])).toBe('smoke');
    expect(suiteFromArgv(['electron', '.', '--perftest'])).toBe('perf');
    expect(suiteFromArgv(['electron', '.', '--uitest'])).toBe('ui');
    expect(suiteFromArgv(['electron', '.', '--docshots'])).toBe('docs');
  });

  it('finds the flag among other arguments; the first flag wins', () => {
    expect(suiteFromArgv(['electron', '.', '--uitest', '--smoke-report', '/tmp/r.json'])).toBe('ui');
    expect(suiteFromArgv(['electron', '.', '--docshots', '--smoke'])).toBe('docs');
  });

  it('matches whole arguments only', () => {
    // The report flag and look-alikes are not suites.
    expect(suiteFromArgv(['--smoke-report', 'file'])).toBeNull();
    expect(suiteFromArgv(['--SMOKE', 'smoke', '-smoke', '--smoke=1', '--uitest '])).toBeNull();
  });

  it('ignores inherited object keys', () => {
    expect(suiteFromArgv(['toString', 'constructor', '__proto__'])).toBeNull();
  });
});
