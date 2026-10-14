import type { Clock, TimerHandle } from '../../src/lib/clock.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock: time only moves when a test calls advance(). */
export class FakeClock implements Clock {
  private mono = 10_000;
  private wall = Date.UTC(2026, 0, 1, 12, 0, 0);
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;

  now(): number {
    return this.mono;
  }

  wallNow(): number {
    return this.wall;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.mono + Math.max(0, ms), fn });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | null | undefined): void {
    if (handle !== null && handle !== undefined) this.timers.delete(handle as unknown as number);
  }

  /** Moves time forward, firing due timers in order and letting work settle after each. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const target = this.mono + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.timers.values()) {
        if (timer.at <= target && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) {
          next = timer;
        }
      }
      if (!next) break;
      this.moveTo(next.at);
      this.timers.delete(next.id);
      next.fn();
      await settle();
    }
    this.moveTo(target);
    await settle();
  }

  private moveTo(mono: number): void {
    this.wall += mono - this.mono;
    this.mono = mono;
  }
}
