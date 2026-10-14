import type { Logger } from 'pino';
import type { AcceptedOperation } from '../drawing/operations.js';
import type { GameRepository } from '../game/repository.js';
import { AppError } from '../lib/errors.js';
import type { Metrics } from '../observability/metrics.js';

interface PendingOp {
  op: AcceptedOperation;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface DrawingSink {
  enqueue(op: AcceptedOperation): Promise<void>;
  /** Clears the failure mark after the room has rolled the turn back. */
  resetTurn(turnId: string): void;
  forgetTurn(turnId: string): void;
}

/**
 * Coalesces accepted drawing operations from every room into short
 * transactions (one multi-row insert per flush). Callers acknowledge and
 * broadcast only after their operation's promise resolves, so anything a
 * client has seen is already durable.
 *
 * If a batch fails, each turn in it is retried on its own so one bad turn
 * cannot block others. A turn whose write fails is marked failed and later
 * operations for it are rejected until the room rolls back and calls
 * resetTurn, which keeps canvas sequences gap-free.
 */
export class DrawingWriter implements DrawingSink {
  private pending: PendingOp[] = [];
  private readonly failedTurns = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly repo: Pick<GameRepository, 'appendDrawingOperations'>,
    private readonly options: { batchMs: number; maxPending: number },
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(op: AcceptedOperation): Promise<void> {
    if (this.failedTurns.has(op.turnId)) {
      return Promise.reject(new AppError('UNAVAILABLE', 'Drawing storage failed for this turn'));
    }
    if (this.pending.length >= this.options.maxPending) {
      this.metrics?.inc('drawing_writer_rejected_busy');
      return Promise.reject(new AppError('BUSY', 'Drawing storage is overloaded', 250));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ op, resolve, reject });
      this.schedule();
    });
  }

  resetTurn(turnId: string): void {
    this.failedTurns.delete(turnId);
  }

  forgetTurn(turnId: string): void {
    this.failedTurns.delete(turnId);
  }

  /** Writes everything queued so far (used by shutdown and tests). */
  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.length > 0 || this.flushing) {
      await this.flush();
    }
  }

  private schedule(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.batchMs);
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        await this.write(batch);
      }
    })().finally(() => {
      this.flushing = null;
      if (this.pending.length > 0) this.schedule();
    });
    return this.flushing;
  }

  private async write(batch: PendingOp[]): Promise<void> {
    const live: PendingOp[] = [];
    for (const item of batch) {
      if (this.failedTurns.has(item.op.turnId)) {
        item.reject(new AppError('UNAVAILABLE', 'Drawing storage failed for this turn'));
      } else {
        live.push(item);
      }
    }
    if (live.length === 0) return;

    const started = performance.now();
    try {
      await this.repo.appendDrawingOperations(live.map((item) => item.op));
      this.metrics?.observe('drawing_batch_commit_ms', performance.now() - started);
      this.metrics?.observe('drawing_batch_size', live.length);
      this.metrics?.inc('drawing_ops_committed', live.length);
      for (const item of live) item.resolve();
      return;
    } catch (err) {
      this.logger.warn({ err, size: live.length }, 'drawing batch failed; retrying per turn');
    }

    const byTurn = new Map<string, PendingOp[]>();
    for (const item of live) {
      const group = byTurn.get(item.op.turnId);
      if (group) group.push(item);
      else byTurn.set(item.op.turnId, [item]);
    }
    for (const [turnId, group] of byTurn) {
      try {
        await this.repo.appendDrawingOperations(group.map((item) => item.op));
        this.metrics?.inc('drawing_ops_committed', group.length);
        for (const item of group) item.resolve();
      } catch (err) {
        this.failedTurns.add(turnId);
        this.metrics?.inc('drawing_ops_failed', group.length);
        this.logger.error({ err, turnId, size: group.length }, 'drawing operations could not be stored');
        for (const item of group) item.reject(new AppError('UNAVAILABLE', 'Drawing could not be saved'));
      }
    }
  }
}
