import { z } from 'zod';
import { AppError } from '../lib/errors.js';

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 700;
export const BRUSH_MIN = 1;
export const BRUSH_MAX = 40;
export const MAX_POINTS_PER_BATCH = 64;
export const MAX_STROKE_POINTS = 4096;
export const MAX_STROKE_MS = 10_000;
/** Allowance for network jitter on the 10 s stroke limit. */
const STROKE_TIME_SLACK_MS = 1_000;
export const MAX_OPERATION_BYTES = 8 * 1024;
export const TURN_BYTE_BUDGET = 4 * 1024 * 1024;
export const ERASER_COLOR = '#ffffff';

const point = z.tuple([z.number(), z.number()]);
const strokeId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const actionId = z.string().regex(/^a\d{1,7}$/);

export const drawOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('stroke.begin'),
    strokeId,
    tool: z.enum(['pen', 'eraser']),
    color,
    width: z.number().int().min(BRUSH_MIN).max(BRUSH_MAX),
    point,
  }),
  z.strictObject({
    type: z.literal('stroke.points'),
    strokeId,
    points: z.array(point).min(1).max(MAX_POINTS_PER_BATCH),
  }),
  z.strictObject({ type: z.literal('stroke.end'), strokeId }),
  z.strictObject({ type: z.literal('fill'), point, color }),
  z.strictObject({ type: z.literal('undo'), targetActionId: actionId }),
  z.strictObject({ type: z.literal('clear') }),
]);

export type DrawOperation = z.infer<typeof drawOperationSchema>;
export type Point = [number, number];

export interface AcceptedOperation {
  turnId: string;
  commandId: string;
  canvasSeq: number;
  /** Milliseconds since drawing started, assigned by the server. */
  elapsedMs: number;
  actionId: string;
  operation: DrawOperation;
}

function clampPoint([x, y]: Point): Point {
  return [
    Math.min(CANVAS_WIDTH - 1, Math.max(0, Math.round(x))),
    Math.min(CANVAS_HEIGHT - 1, Math.max(0, Math.round(y))),
  ];
}

/** Canonical form: integer in-bounds coordinates, lowercase colours, white eraser. */
export function canonicalize(op: DrawOperation): DrawOperation {
  switch (op.type) {
    case 'stroke.begin':
      return {
        ...op,
        color: op.tool === 'eraser' ? ERASER_COLOR : op.color.toLowerCase(),
        point: clampPoint(op.point),
      };
    case 'stroke.points':
      return { ...op, points: op.points.map(clampPoint) };
    case 'fill':
      return { ...op, point: clampPoint(op.point), color: op.color.toLowerCase() };
    default:
      return op;
  }
}

export function operationBytes(op: DrawOperation): number {
  return Buffer.byteLength(JSON.stringify(op), 'utf8');
}

/** Ops that are expensive for every client to render; rate limited separately. */
export function isHeavyOperation(op: DrawOperation): boolean {
  return op.type === 'fill' || op.type === 'undo' || op.type === 'clear';
}

interface OpenStroke {
  strokeId: string;
  actionId: string;
  points: number;
  beganAtMs: number;
}

/**
 * Authoritative drawing log for one turn. Allocates canvas sequence numbers
 * and action IDs, and enforces stroke lifetime, undo targets and the turn
 * byte budget. Accepted-but-uncommitted operations can be rolled back if
 * persistence fails.
 */
export class TurnCanvas {
  readonly ops: AcceptedOperation[] = [];
  committedSeq = 0;
  bytes = 0;
  /** Set while a persistence failure is being rolled back. */
  failed = false;

  private nextActionNumber = 1;
  private open: OpenStroke | null = null;
  private readonly usedStrokeIds = new Set<string>();
  private readonly activeActions: string[] = [];

  constructor(readonly turnId: string) {}

  get lastSeq(): number {
    return this.ops.length;
  }

  get hasOpenStroke(): boolean {
    return this.open !== null;
  }

  apply(commandId: string, rawOperation: DrawOperation, elapsedMs: number): AcceptedOperation {
    const operation = canonicalize(rawOperation);
    const size = operationBytes(operation);
    if (size > MAX_OPERATION_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'Drawing operation too large');
    // Ending a stroke is always allowed so the budget can never leave one stuck open.
    if (operation.type !== 'stroke.end' && this.bytes + size > TURN_BYTE_BUDGET) {
      throw new AppError('TURN_BUDGET_EXCEEDED', 'This drawing has reached its size limit');
    }
    const actionId = this.step(operation, Math.max(0, Math.round(elapsedMs)));
    this.bytes += size;
    const accepted: AcceptedOperation = {
      turnId: this.turnId,
      commandId,
      canvasSeq: this.ops.length + 1,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
      actionId,
      operation,
    };
    this.ops.push(accepted);
    return accepted;
  }

  markCommitted(seq: number): void {
    if (seq > this.committedSeq) this.committedSeq = seq;
  }

  /** Discards uncommitted operations and rebuilds stroke/undo state from the committed log. */
  rollbackToCommitted(): void {
    const committed = this.ops.slice(0, this.committedSeq);
    this.ops.length = 0;
    this.bytes = 0;
    this.nextActionNumber = 1;
    this.open = null;
    this.usedStrokeIds.clear();
    this.activeActions.length = 0;
    for (const op of committed) {
      this.step(op.operation, op.elapsedMs);
      this.bytes += operationBytes(op.operation);
      this.ops.push(op);
    }
    this.failed = false;
  }

  committedOpsAfter(seq: number): AcceptedOperation[] {
    return this.ops.slice(Math.max(0, seq), this.committedSeq);
  }

  private step(op: DrawOperation, elapsedMs: number): string {
    switch (op.type) {
      case 'stroke.begin': {
        if (this.open) throw new AppError('INVALID_OPERATION', 'A stroke is already open');
        if (this.usedStrokeIds.has(op.strokeId)) throw new AppError('INVALID_OPERATION', 'Stroke ID reused');
        const actionId = this.newActionId();
        this.open = { strokeId: op.strokeId, actionId, points: 1, beganAtMs: elapsedMs };
        this.usedStrokeIds.add(op.strokeId);
        return actionId;
      }
      case 'stroke.points': {
        const open = this.requireOpen(op.strokeId);
        if (open.points + op.points.length > MAX_STROKE_POINTS) {
          throw new AppError('INVALID_OPERATION', 'Stroke has too many points; end it and begin another');
        }
        if (elapsedMs - open.beganAtMs > MAX_STROKE_MS + STROKE_TIME_SLACK_MS) {
          throw new AppError('INVALID_OPERATION', 'Stroke is too long; end it and begin another');
        }
        open.points += op.points.length;
        return open.actionId;
      }
      case 'stroke.end': {
        const open = this.requireOpen(op.strokeId);
        this.open = null;
        this.activeActions.push(open.actionId);
        return open.actionId;
      }
      case 'fill':
      case 'clear': {
        this.requireClosed();
        const actionId = this.newActionId();
        this.activeActions.push(actionId);
        return actionId;
      }
      case 'undo': {
        this.requireClosed();
        const latest = this.activeActions.at(-1);
        if (latest === undefined || latest !== op.targetActionId) {
          throw new AppError('INVALID_OPERATION', 'Undo must target the latest drawing action');
        }
        this.activeActions.pop();
        return this.newActionId();
      }
    }
  }

  private requireOpen(strokeId: string): OpenStroke {
    if (!this.open || this.open.strokeId !== strokeId) {
      throw new AppError('INVALID_OPERATION', 'No open stroke with that ID');
    }
    return this.open;
  }

  private requireClosed(): void {
    if (this.open) throw new AppError('INVALID_OPERATION', 'Finish the current stroke first');
  }

  private newActionId(): string {
    return `a${this.nextActionNumber++}`;
  }
}
