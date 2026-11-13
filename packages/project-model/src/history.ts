/**
 * Undo/redo over immutable documents. Because commands never mutate, keeping previous
 * documents costs only the changed branches. Consecutive pushes with the same
 * coalesce key inside the window become one undo step (one drag = one step).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey: string | undefined;
  private lastTime = 0;
  private _present: T;

  constructor(present: T, private readonly limit = 500, private readonly coalesceWindowMs = 1000) {
    this._present = present;
  }

  get present(): T {
    return this._present;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: T, opts: { coalesceKey?: string; now?: number } = {}): void {
    if (next === this._present) return;
    const now = opts.now ?? Date.now();
    const coalesce = opts.coalesceKey !== undefined && opts.coalesceKey === this.lastKey && now - this.lastTime < this.coalesceWindowMs;
    if (!coalesce) {
      this.past.push(this._present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this._present = next;
    this.future = [];
    this.lastKey = opts.coalesceKey;
    this.lastTime = now;
  }

  /** Ends the current gesture so the next push starts a new undo step. */
  breakCoalescing(): void {
    this.lastKey = undefined;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this._present);
    this._present = prev;
    this.lastKey = undefined;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this._present);
    this._present = next;
    this.lastKey = undefined;
    return true;
  }

  reset(present: T): void {
    this.past = [];
    this.future = [];
    this.lastKey = undefined;
    this._present = present;
  }
}
