import type { DrawOperation } from '../lib/protocol'
import { Raster, WHITE, packColor } from './raster'

type Action =
  | { id: string; kind: 'stroke'; color: number; width: number; points: number[]; complete: boolean; active: boolean }
  | { id: string; kind: 'fill'; color: number; x: number; y: number; complete: true; active: boolean }
  | { id: string; kind: 'clear'; complete: true; active: boolean }

interface Checkpoint {
  /** State after actions [0, index) were applied. */
  index: number
  pixels: Uint32Array
}

const CHECKPOINT_EVERY = 40
const MAX_CHECKPOINTS = 3

/**
 * Turns drawing operations into pixels. Strokes, fills and clears are
 * actions; undo deactivates the latest one and the bitmap is rebuilt from
 * the newest valid starting point (last active clear or a checkpoint), so
 * long drawings do not replay from scratch.
 */
export class CanvasModel {
  readonly raster = new Raster()
  private actions: Action[] = []
  private readonly index = new Map<string, number>()
  private checkpoints: Checkpoint[] = []

  reset(): void {
    this.actions = []
    this.index.clear()
    this.checkpoints = []
    this.raster.clear()
  }

  /** Rebuilds everything from an ordered operation list. */
  replay(ops: ReadonlyArray<{ op: DrawOperation; actionId: string }>): void {
    this.reset()
    for (const { op, actionId } of ops) this.apply(op, actionId)
  }

  /** ID of the latest active, finished action (what undo would remove). */
  latestUndoable(): string | null {
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i]!
      if (action.active) return action.complete ? action.id : null
    }
    return null
  }

  get hasContent(): boolean {
    return this.actions.some((a) => a.active)
  }

  apply(op: DrawOperation, actionId: string): void {
    const { raster } = this
    switch (op.type) {
      case 'stroke.begin': {
        const color = packColor(op.color)
        this.push({ id: actionId, kind: 'stroke', color, width: op.width, points: [op.point[0], op.point[1]], complete: false, active: true })
        raster.stamp(op.point[0], op.point[1], op.width, color)
        return
      }
      case 'stroke.points': {
        const action = this.find(actionId)
        if (!action || action.kind !== 'stroke') return
        const pts = action.points
        let lastX = pts[pts.length - 2]!
        let lastY = pts[pts.length - 1]!
        for (const [x, y] of op.points) {
          raster.line(lastX, lastY, x, y, action.width, action.color)
          pts.push(x, y)
          lastX = x
          lastY = y
        }
        return
      }
      case 'stroke.end': {
        const action = this.find(actionId)
        if (action && action.kind === 'stroke') action.complete = true
        this.maybeCheckpoint()
        return
      }
      case 'fill': {
        const color = packColor(op.color)
        this.push({ id: actionId, kind: 'fill', color, x: op.point[0], y: op.point[1], complete: true, active: true })
        raster.fill(op.point[0], op.point[1], color)
        this.maybeCheckpoint()
        return
      }
      case 'clear': {
        this.push({ id: actionId, kind: 'clear', complete: true, active: true })
        raster.clear()
        return
      }
      case 'undo': {
        const position = this.index.get(op.targetActionId)
        const action = position === undefined ? undefined : this.actions[position]
        if (!action || !action.active) return
        action.active = false
        this.rebuildAfterUndo(position!)
        return
      }
    }
  }

  private push(action: Action): void {
    this.index.set(action.id, this.actions.length)
    this.actions.push(action)
  }

  private find(id: string): Action | undefined {
    const position = this.index.get(id)
    return position === undefined ? undefined : this.actions[position]
  }

  private maybeCheckpoint(): void {
    const count = this.actions.length
    const last = this.checkpoints.at(-1)?.index ?? 0
    if (count - last < CHECKPOINT_EVERY) return
    // Only checkpoint between finished actions.
    if (this.actions.some((a, i) => i >= last && !a.complete)) return
    this.checkpoints.push({ index: count, pixels: this.raster.pixels.slice() })
    if (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift()
  }

  private rebuildAfterUndo(undone: number): void {
    // Checkpoints taken after the undone action no longer describe the canvas.
    this.checkpoints = this.checkpoints.filter((c) => c.index <= undone)
    let start = 0
    let base: Uint32Array | null = null
    const checkpoint = this.checkpoints.at(-1)
    if (checkpoint) {
      start = checkpoint.index
      base = checkpoint.pixels
    }
    // Anything before the last active clear is invisible; start there if it is later.
    for (let i = this.actions.length - 1; i >= start; i--) {
      const action = this.actions[i]!
      if (action.kind === 'clear' && action.active) {
        start = i
        base = null
        break
      }
    }
    if (base) this.raster.copyFrom(base)
    else this.raster.clear(WHITE)
    for (let i = start; i < this.actions.length; i++) {
      const action = this.actions[i]!
      if (action.active) this.draw(action)
    }
  }

  private draw(action: Action): void {
    const { raster } = this
    if (action.kind === 'clear') {
      raster.clear()
    } else if (action.kind === 'fill') {
      raster.fill(action.x, action.y, action.color)
    } else {
      const pts = action.points
      raster.stamp(pts[0]!, pts[1]!, action.width, action.color)
      for (let i = 2; i < pts.length; i += 2) {
        raster.line(pts[i - 2]!, pts[i - 1]!, pts[i]!, pts[i + 1]!, action.width, action.color)
      }
    }
  }
}
