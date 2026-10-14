import { performance } from 'node:perf_hooks';

export type TimerHandle = { readonly __timer: unique symbol };

/**
 * Time source for game rules. `now()` is monotonic and drives deadlines and
 * scoring; `wallNow()` is only for client display and persistence.
 */
export interface Clock {
  now(): number;
  wallNow(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.max(0, ms)) as unknown as TimerHandle,
  clearTimeout: (handle) => {
    if (handle) globalThis.clearTimeout(handle as unknown as NodeJS.Timeout);
  },
};
