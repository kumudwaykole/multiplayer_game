import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

const WINDOW = 4096;
/** Event-loop sampling interval; the histogram records the full interval, so it is subtracted. */
const LOOP_RESOLUTION_MS = 20;

/** Rolling window of recent samples for percentiles. */
class Summary {
  private readonly samples = new Float64Array(WINDOW);
  private index = 0;
  private filled = 0;
  count = 0;
  sum = 0;

  add(value: number): void {
    this.samples[this.index] = value;
    this.index = (this.index + 1) % WINDOW;
    this.filled = Math.min(WINDOW, this.filled + 1);
    this.count++;
    this.sum += value;
  }

  report(): { count: number; mean: number; p50: number; p95: number; p99: number; max: number } {
    const values = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const at = (q: number) => (values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(q * values.length))]!);
    return {
      count: this.count,
      mean: this.count === 0 ? 0 : this.sum / this.count,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: values.at(-1) ?? 0,
    };
  }
}

const lag = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);

/** Minimal in-process metrics. Exposed at /api/metrics only with a token. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly summaries = new Map<string, Summary>();
  private readonly loopDelay: IntervalHistogram;
  private readonly startedAt = Date.now();

  constructor() {
    this.loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loopDelay.enable();
  }

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, value: number): void {
    let summary = this.summaries.get(name);
    if (!summary) {
      summary = new Summary();
      this.summaries.set(name, summary);
    }
    summary.add(value);
  }

  snapshot(gauges: Record<string, number>): Record<string, unknown> {
    const memory = process.memoryUsage();
    const report = {
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      gauges: {
        ...gauges,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      // Lag beyond the sampling interval (Windows timer granularity adds a few ms of its own).
      eventLoopDelayMs: {
        p50: lag(this.loopDelay.percentile(50)),
        p99: lag(this.loopDelay.percentile(99)),
        max: lag(this.loopDelay.max),
      },
      counters: Object.fromEntries(this.counters),
      summaries: Object.fromEntries([...this.summaries].map(([name, s]) => [name, s.report()])),
    };
    this.loopDelay.reset();
    return report;
  }

  stop(): void {
    this.loopDelay.disable();
  }
}
