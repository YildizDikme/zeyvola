import { describe, expect, it, vi } from 'vitest';
import { CompositorHolder, Failure, retryOnce, waitForEncodeQueue } from './exporter';

class FakeEncoder {
  encodeQueueSize = 10;
  state = 'configured';
  private l = new Set<() => void>();
  addEventListener(_: 'dequeue', fn: () => void) { this.l.add(fn); }
  removeEventListener(_: 'dequeue', fn: () => void) { this.l.delete(fn); }
  dequeue(n: number) { this.encodeQueueSize = n; for (const f of [...this.l]) { this.l.delete(f); f(); } }
  get listeners() { return this.l.size; }
}

describe('waitForEncodeQueue', () => {
  it('returns once the queue drains', async () => {
    const enc = new FakeEncoder();
    const p = waitForEncodeQueue(enc, 6, new Failure(), new AbortController().signal);
    enc.dequeue(8);
    enc.dequeue(5);
    await expect(p).resolves.toBeUndefined();
    expect(enc.listeners).toBe(0);
  });

  it('rejects with the encoder error instead of waiting forever for a dequeue', async () => {
    const enc = new FakeEncoder();
    const failure = new Failure();
    const p = waitForEncodeQueue(enc, 6, failure, new AbortController().signal, 60_000);
    failure.set(new Error('encoder exploded'));
    await expect(p).rejects.toThrow('encoder exploded');
  });

  it('notices a closed encoder even with no error callback', async () => {
    const enc = new FakeEncoder();
    const p = waitForEncodeQueue(enc, 6, new Failure(), new AbortController().signal, 5);
    enc.state = 'closed';
    await expect(p).rejects.toThrow();
  });

  it('stops on abort', async () => {
    const enc = new FakeEncoder();
    const ac = new AbortController();
    const p = waitForEncodeQueue(enc, 6, new Failure(), ac.signal, 60_000);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('Failure', () => {
  it('keeps the first error and races pending work', async () => {
    const f = new Failure();
    const never = new Promise<void>(() => undefined);
    const raced = f.race(never);
    f.set(new Error('first'));
    f.set(new Error('second'));
    await expect(raced).rejects.toThrow('first');
    expect(() => f.throwIfSet()).toThrow('first');
    await expect(f.race(Promise.resolve(1))).rejects.toThrow('first');
  });

  it('passes results through while nothing failed', async () => {
    await expect(new Failure().race(Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('retryOnce', () => {
  it('retries once after a reset, then wraps the error', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('timeout'));
    const reset = vi.fn();
    await expect(retryOnce(attempt, reset, () => new Error('Kaynak video okunamadı: screen.webm'))).rejects.toThrow('screen.webm');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the second try', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('frame');
    await expect(retryOnce(attempt, () => undefined, (e) => e)).resolves.toBe('frame');
  });

  it('never retries an abort', async () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    const attempt = vi.fn().mockRejectedValue(abort);
    await expect(retryOnce(attempt, () => undefined, () => new Error('wrapped'))).rejects.toBe(abort);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('CompositorHolder', () => {
  class FakeComp { lost = false; disposed = false; dispose() { this.disposed = true; } }

  it('keeps one compositor while its context lives', () => {
    const make = vi.fn(() => new FakeComp());
    const h = new CompositorHolder(make);
    h.draw(() => 1);
    h.draw(() => 2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('draws again on a new compositor when the context is lost during drawing', () => {
    const made: FakeComp[] = [];
    const h = new CompositorHolder(() => { const c = new FakeComp(); made.push(c); return c; });
    const discarded: string[] = [];
    let calls = 0;
    const out = h.draw((c) => {
      calls++;
      if (calls === 1) c.lost = true; // context taken away while this frame was drawn
      return `frame${calls}`;
    }, (r) => discarded.push(r));
    expect(out).toBe('frame2');
    expect(discarded).toEqual(['frame1']);
    expect(made).toHaveLength(2);
    expect(made[0]!.disposed).toBe(true);
  });

  it('gives up with an error instead of producing blank frames forever', () => {
    const h = new CompositorHolder(() => new FakeComp(), 2);
    expect(() => h.draw((c) => { c.lost = true; return 0; })).toThrow();
  });
});
