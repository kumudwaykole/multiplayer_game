import { AppError } from './errors.js';

/**
 * Runs tasks one at a time in arrival order. Every command for a room goes
 * through one of these, so a guess, a timer expiry and a disconnect can never
 * interleave. The depth bound rejects work early instead of building backlog.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly maxDepth = 1000) {}

  get size(): number {
    return this.depth;
  }

  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.depth >= this.maxDepth) {
      return Promise.reject(new AppError('BUSY', 'Room is overloaded, retry shortly', 250));
    }
    this.depth++;
    const result = this.tail.then(task);
    this.tail = result.then(
      () => this.done(),
      () => this.done(),
    );
    return result;
  }

  /** Resolves once every queued task has finished. */
  onIdle(): Promise<void> {
    if (this.depth === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private done(): void {
    this.depth--;
    if (this.depth === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
