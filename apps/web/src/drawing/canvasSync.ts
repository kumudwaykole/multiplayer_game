import type { AcceptedOperation, Ack, DrawOperation, Point } from '../lib/protocol'
import { MAX_POINTS_PER_BATCH } from '../lib/protocol'
import { CanvasModel } from './canvasModel'

export interface DrawTransport {
  send(turnId: string, commandId: string, op: DrawOperation): Promise<Ack>
}

interface Pending {
  commandId: string
  op: DrawOperation
  actionId: string
}

interface OpenStroke {
  strokeId: string
  actionId: string
  tool: 'pen' | 'eraser'
  color: string
  width: number
  points: number
  startedAt: number
  last: Point
}

export interface SnapshotMeta {
  turnId: string | null
  baseSeq: number
  throughSeq: number
  chunkCount: number
}

/** Point batches go out at most this often (and immediately at 64 points). */
const FLUSH_MS = 25
/** The server caps a stroke at 4096 points / 10 s; split a little earlier. */
const STROKE_SPLIT_POINTS = 4000
const STROKE_SPLIT_MS = 9_000
/** How long a sequence gap may stay open before asking for a resync. */
const GAP_TIMEOUT_MS = 800

function actionNumber(id: string): number {
  return Number.parseInt(id.slice(1), 10) || 0
}

/**
 * Keeps one turn's canvas consistent with the server.
 *
 * - `canonical`: operations confirmed by the server, applied strictly in
 *   canvas-sequence order. Duplicates are ignored, gaps are buffered, and a
 *   gap that stays open triggers `onGap` (the connection resubscribes and
 *   gets the missing range).
 * - `pending`: the drawer's own operations, drawn immediately and sent in
 *   order. Their server echo normally matches the head of the queue, so
 *   nothing is redrawn twice. A rejection drops that operation and rebuilds
 *   from canonical + remaining pending.
 *
 * Action IDs are allocated by the server in order; the drawer predicts them
 * (a1, a2, ...) so undo can name its target before the acknowledgement
 * arrives, and corrects the predictions whenever it rebuilds.
 */
export class CanvasSync {
  readonly model = new CanvasModel()
  turnId: string | null = null
  onGap: (() => void) | null = null
  onReject: ((ack: Ack) => void) | null = null

  private canonical: AcceptedOperation[] = []
  private canonicalMax = 0
  private lastSeq = 0
  private pending: Pending[] = []
  private readonly buffered = new Map<number, AcceptedOperation>()
  private snapshot: (SnapshotMeta & { ops: AcceptedOperation[] }) | null = null
  private gapTimer: ReturnType<typeof setTimeout> | null = null

  private transport: DrawTransport | null = null
  private stroke: OpenStroke | null = null
  private batch: Point[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private counter = 0
  private readonly tag = Math.random().toString(36).slice(2, 7)

  get seq(): number {
    return this.lastSeq
  }

  get isDrawing(): boolean {
    return this.stroke !== null
  }

  /** Set while this client is the drawer of the current turn. */
  setTransport(transport: DrawTransport | null): void {
    if (!transport) this.cancelInput()
    this.transport = transport
  }

  reset(turnId: string | null): void {
    this.cancelInput()
    this.turnId = turnId
    this.canonical = []
    this.canonicalMax = 0
    this.lastSeq = 0
    this.pending = []
    this.buffered.clear()
    this.snapshot = null
    this.clearGapTimer()
    this.model.reset()
  }

  // ------------------------------------------------------------ server side

  beginSnapshot(meta: SnapshotMeta): void {
    if (meta.turnId === null) {
      this.reset(null)
      return
    }
    if (meta.turnId !== this.turnId) this.reset(meta.turnId)
    this.snapshot = { ...meta, ops: [] }
    if (meta.chunkCount === 0) this.finishSnapshot()
  }

  addChunk(turnId: string, ops: AcceptedOperation[], last: boolean): void {
    if (!this.snapshot || this.snapshot.turnId !== turnId) return
    this.snapshot.ops.push(...ops)
    if (last) this.finishSnapshot()
  }

  onRemote(op: AcceptedOperation): void {
    if (op.turnId !== this.turnId || op.canvasSeq <= this.lastSeq) return
    if (this.snapshot || op.canvasSeq !== this.lastSeq + 1) {
      this.buffered.set(op.canvasSeq, op)
      if (!this.snapshot) this.armGapTimer()
      return
    }
    this.accept(op)
    this.drain()
  }

  private finishSnapshot(): void {
    const snap = this.snapshot
    if (!snap) return
    this.snapshot = null
    const ops = snap.ops.filter((op) => op.canvasSeq > snap.baseSeq).sort((a, b) => a.canvasSeq - b.canvasSeq)
    if (snap.baseSeq === 0 || snap.baseSeq !== this.lastSeq) {
      // Full snapshot: it replaces everything we had for this turn.
      this.canonical = ops
      this.canonicalMax = ops.reduce((max, op) => Math.max(max, actionNumber(op.actionId)), 0)
      this.lastSeq = snap.throughSeq
      this.pending = []
      this.rebuild()
    } else {
      for (const op of ops) if (op.canvasSeq === this.lastSeq + 1) this.accept(op)
      this.lastSeq = Math.max(this.lastSeq, snap.throughSeq)
    }
    this.drain()
  }

  private drain(): void {
    for (;;) {
      const next = this.buffered.get(this.lastSeq + 1)
      if (!next) break
      this.buffered.delete(next.canvasSeq)
      this.accept(next)
    }
    for (const seq of this.buffered.keys()) if (seq <= this.lastSeq) this.buffered.delete(seq)
    if (this.buffered.size === 0) this.clearGapTimer()
    else this.armGapTimer()
  }

  private accept(op: AcceptedOperation): void {
    this.lastSeq = op.canvasSeq
    this.canonical.push(op)
    this.canonicalMax = Math.max(this.canonicalMax, actionNumber(op.actionId))
    const head = this.pending[0]
    if (head && head.commandId === op.commandId) {
      this.pending.shift()
      if (head.actionId !== op.actionId) this.rebuild()
      return
    }
    if (this.pending.length === 0) {
      this.model.apply(op.operation, op.actionId)
      return
    }
    this.pending = this.pending.filter((p) => p.commandId !== op.commandId)
    this.rebuild()
  }

  private armGapTimer(): void {
    if (this.gapTimer) return
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null
      if (this.buffered.size > 0) this.onGap?.()
    }, GAP_TIMEOUT_MS)
  }

  private clearGapTimer(): void {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
  }

  /** Redraws canonical + pending (+ the unsent part of an open stroke). */
  private rebuild(): void {
    this.repredict()
    const ops: Array<{ op: DrawOperation; actionId: string }> = this.canonical.map((o) => ({
      op: o.operation,
      actionId: o.actionId,
    }))
    ops.push(...this.pending)
    if (this.stroke && this.batch.length > 0) {
      ops.push({ op: { type: 'stroke.points', strokeId: this.stroke.strokeId, points: [...this.batch] }, actionId: this.stroke.actionId })
    }
    this.model.replay(ops)
  }

  private repredict(): void {
    let next = this.canonicalMax + 1
    const strokes = new Map<string, string>()
    for (const o of this.canonical) {
      if (o.operation.type === 'stroke.begin') strokes.set(o.operation.strokeId, o.actionId)
    }
    for (const p of this.pending) {
      if (p.op.type === 'stroke.begin') {
        p.actionId = `a${next++}`
        strokes.set(p.op.strokeId, p.actionId)
      } else if (p.op.type === 'stroke.points' || p.op.type === 'stroke.end') {
        p.actionId = strokes.get(p.op.strokeId) ?? p.actionId
      } else {
        p.actionId = `a${next++}`
      }
    }
    if (this.stroke) this.stroke.actionId = strokes.get(this.stroke.strokeId) ?? this.stroke.actionId
  }

  // ------------------------------------------------------------- drawer side

  beginStroke(tool: 'pen' | 'eraser', color: string, width: number, point: Point, now: number): void {
    if (!this.transport || !this.turnId) return
    if (this.stroke) this.endStroke()
    const strokeId = `s${this.tag}${(++this.counter).toString(36)}`
    const op: DrawOperation = {
      type: 'stroke.begin',
      strokeId,
      tool,
      color: tool === 'eraser' ? '#ffffff' : color,
      width,
      point,
    }
    const actionId = this.local(op, true)
    this.stroke = { strokeId, actionId, tool, color, width, points: 1, startedAt: now, last: point }
  }

  addPoint(point: Point, now: number): void {
    const stroke = this.stroke
    if (!stroke) return
    if (point[0] === stroke.last[0] && point[1] === stroke.last[1]) return
    if (stroke.points >= STROKE_SPLIT_POINTS || now - stroke.startedAt >= STROKE_SPLIT_MS) {
      // Long gesture: close this stroke and continue seamlessly with a new one.
      const { tool, color, width, last } = stroke
      this.endStroke()
      this.beginStroke(tool, color, width, last, now)
    }
    const current = this.stroke!
    this.model.apply({ type: 'stroke.points', strokeId: current.strokeId, points: [point] }, current.actionId)
    current.last = point
    current.points++
    this.batch.push(point)
    if (this.batch.length >= MAX_POINTS_PER_BATCH) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  endStroke(): void {
    const stroke = this.stroke
    if (!stroke) return
    this.flush()
    this.local({ type: 'stroke.end', strokeId: stroke.strokeId }, true)
    this.stroke = null
  }

  fill(point: Point, color: string): void {
    if (!this.transport || !this.turnId || this.stroke) return
    this.local({ type: 'fill', point, color }, true)
  }

  clear(): void {
    if (!this.transport || !this.turnId || this.stroke) return
    if (!this.model.hasContent) return
    this.local({ type: 'clear' }, true)
  }

  undo(): boolean {
    if (!this.transport || !this.turnId || this.stroke) return false
    const target = this.model.latestUndoable()
    if (!target) return false
    this.local({ type: 'undo', targetActionId: target }, true)
    return true
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    const stroke = this.stroke
    if (!stroke || this.batch.length === 0) return
    const points = this.batch
    this.batch = []
    // Already drawn point by point in addPoint.
    this.local({ type: 'stroke.points', strokeId: stroke.strokeId, points }, false)
  }

  /** Queues and sends one of our own operations. Returns its (predicted) action ID. */
  private local(op: DrawOperation, draw: boolean): string {
    const commandId = `d${this.tag}${(++this.counter).toString(36)}`
    let actionId: string
    if (op.type === 'stroke.points' || op.type === 'stroke.end') {
      actionId = this.stroke?.actionId ?? 'a0'
    } else {
      const pendingMax = this.pending.reduce((max, p) => Math.max(max, actionNumber(p.actionId)), 0)
      actionId = `a${Math.max(this.canonicalMax, pendingMax) + 1}`
    }
    this.pending.push({ commandId, op, actionId })
    if (draw) this.model.apply(op, actionId)
    const turnId = this.turnId!
    void this.transport!.send(turnId, commandId, op).then((ack) => {
      if (!ack.ok && this.turnId === turnId) this.reject(commandId, ack)
    })
    return actionId
  }

  private reject(commandId: string, ack: Ack): void {
    const index = this.pending.findIndex((p) => p.commandId === commandId)
    if (index === -1) return
    const [rejected] = this.pending.splice(index, 1)
    if (rejected!.op.type === 'stroke.begin' && this.stroke?.strokeId === rejected!.op.strokeId) {
      // The server never opened this stroke; stop sending its points.
      this.stroke = null
      this.batch = []
    }
    this.rebuild()
    this.onReject?.(ack)
  }

  private cancelInput(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.stroke = null
    this.batch = []
  }
}
