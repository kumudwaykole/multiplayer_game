import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AcceptedOperation, Ack, DrawOperation } from '../lib/protocol'
import { CanvasModel } from './canvasModel'
import { CanvasSync } from './canvasSync'
import { Raster, WHITE, packColor } from './raster'

const RED = packColor('#ff0000')
const BLUE = packColor('#0000ff')

function px(raster: Raster, x: number, y: number): number {
  return raster.pixels[y * raster.width + x]!
}

describe('Raster', () => {
  it('packs colours in ImageData byte order', () => {
    const bytes = new Uint8Array(new Uint32Array([packColor('#123456')]).buffer)
    expect([...bytes]).toEqual([0x12, 0x34, 0x56, 0xff])
  })

  it('stamps hard-edged discs with no anti-aliasing', () => {
    const r = new Raster()
    r.stamp(100, 100, 10, RED)
    expect(px(r, 100, 100)).toBe(RED)
    expect(px(r, 105, 100)).toBe(RED)
    expect(px(r, 106, 100)).toBe(WHITE)
    const colours = new Set(r.pixels)
    expect(colours).toEqual(new Set([WHITE, RED]))
  })

  it('draws continuous lines', () => {
    const r = new Raster()
    r.line(10, 10, 200, 90, 1, RED)
    let count = 0
    for (let x = 11; x <= 200; x++) {
      for (let y = 0; y < 700; y++) if (px(r, x, y) === RED) count++
    }
    expect(count).toBeGreaterThanOrEqual(190)
  })

  it('flood fills exactly up to a boundary and leaves the rest alone', () => {
    const r = new Raster()
    for (let x = 0; x < 1000; x++) r.pixels[350 * 1000 + x] = RED
    r.fill(5, 5, BLUE)
    expect(px(r, 999, 349)).toBe(BLUE)
    expect(px(r, 5, 350)).toBe(RED)
    expect(px(r, 5, 351)).toBe(WHITE)
  })

  it('tracks a dirty rectangle and notifies once per flush', () => {
    const r = new Raster()
    r.takeDirty()
    const onDirty = vi.fn()
    r.onDirty = onDirty
    r.stamp(50, 60, 4, RED)
    r.stamp(70, 80, 4, RED)
    expect(onDirty).toHaveBeenCalledTimes(1)
    expect(r.takeDirty()).toEqual({ x: 48, y: 58, w: 25, h: 25 })
    expect(r.takeDirty()).toBeNull()
  })
})

const strokeOps = (id: string, color: string, points: Array<[number, number]>): DrawOperation[] => [
  { type: 'stroke.begin', strokeId: id, tool: 'pen', color, width: 8, point: points[0]! },
  { type: 'stroke.points', strokeId: id, points: points.slice(1) },
  { type: 'stroke.end', strokeId: id },
]

describe('CanvasModel', () => {
  it('produces the same pixels however a stroke is batched', () => {
    const points: Array<[number, number]> = [[10, 10], [80, 40], [160, 30], [300, 200], [420, 180]]
    const whole = new CanvasModel()
    whole.replay(strokeOps('s1', '#ff0000', points).map((op) => ({ op, actionId: 'a1' })))
    const split = new CanvasModel()
    split.apply({ type: 'stroke.begin', strokeId: 's1', tool: 'pen', color: '#ff0000', width: 8, point: points[0]! }, 'a1')
    for (const p of points.slice(1)) split.apply({ type: 'stroke.points', strokeId: 's1', points: [p] }, 'a1')
    expect(split.raster.hash()).toBe(whole.raster.hash())
  })

  it('undoes the latest action, including clear and fill, back to identical pixels', () => {
    const model = new CanvasModel()
    const blank = model.raster.hash()
    strokeOps('s1', '#ff0000', [[100, 100], [300, 300]]).forEach((op) => model.apply(op, 'a1'))
    const afterStroke = model.raster.hash()
    model.apply({ type: 'fill', point: [900, 600], color: '#00ff00' }, 'a2')
    model.apply({ type: 'clear' }, 'a3')
    expect(model.raster.hash()).toBe(blank)
    expect(model.latestUndoable()).toBe('a3')
    model.apply({ type: 'undo', targetActionId: 'a3' }, 'a4')
    model.apply({ type: 'undo', targetActionId: 'a2' }, 'a5')
    expect(model.raster.hash()).toBe(afterStroke)
    model.apply({ type: 'undo', targetActionId: 'a1' }, 'a6')
    expect(model.raster.hash()).toBe(blank)
  })

  it('matches a from-scratch replay after many actions and undos (checkpoints stay valid)', () => {
    const model = new CanvasModel()
    const log: Array<{ op: DrawOperation; actionId: string }> = []
    let n = 0
    const push = (op: DrawOperation, actionId: string) => {
      model.apply(op, actionId)
      log.push({ op, actionId })
    }
    for (let i = 0; i < 120; i++) {
      const id = `a${++n}`
      const x = (i * 37) % 900
      strokeOps(`s${i}`, i % 2 ? '#ff0000' : '#0000ff', [[x, 50], [x + 40, 400]]).forEach((op) => push(op, id))
      if (i % 25 === 24) push({ type: 'fill', point: [999, 699], color: '#ffe400' }, `a${++n}`)
    }
    for (let k = 0; k < 50; k++) {
      const target = model.latestUndoable()!
      push({ type: 'undo', targetActionId: target }, `a${++n}`)
    }
    const fresh = new CanvasModel()
    fresh.replay(log)
    expect(model.raster.hash()).toBe(fresh.raster.hash())
  })
})

function accepted(turnId: string, seq: number, op: DrawOperation, actionId: string, commandId = `remote${seq}`): AcceptedOperation {
  return { turnId, canvasSeq: seq, commandId, elapsedMs: seq * 10, actionId, operation: op }
}

describe('CanvasSync', () => {
  afterEach(() => vi.useRealTimers())

  it('applies remote operations in sequence order, buffering gaps and ignoring duplicates', () => {
    const sync = new CanvasSync()
    sync.reset('t1')
    const ops = strokeOps('s1', '#ff0000', [[10, 10], [500, 500]])
    const reference = new CanvasModel()
    ops.forEach((op) => reference.apply(op, 'a1'))

    sync.onRemote(accepted('t1', 2, ops[1]!, 'a1'))
    expect(sync.seq).toBe(0)
    sync.onRemote(accepted('t1', 1, ops[0]!, 'a1'))
    sync.onRemote(accepted('t1', 1, ops[0]!, 'a1'))
    sync.onRemote(accepted('t1', 3, ops[2]!, 'a1'))
    expect(sync.seq).toBe(3)
    expect(sync.model.raster.hash()).toBe(reference.raster.hash())
  })

  it('asks for a resync when a gap stays open', () => {
    vi.useFakeTimers()
    const sync = new CanvasSync()
    sync.reset('t1')
    const onGap = vi.fn()
    sync.onGap = onGap
    sync.onRemote(accepted('t1', 3, { type: 'clear' }, 'a1'))
    vi.advanceTimersByTime(1000)
    expect(onGap).toHaveBeenCalledTimes(1)
  })

  it('ignores operations from another turn', () => {
    const sync = new CanvasSync()
    sync.reset('t2')
    sync.onRemote(accepted('t1', 1, { type: 'fill', point: [1, 1], color: '#ff0000' }, 'a1'))
    expect(sync.seq).toBe(0)
  })

  it('draws the drawer’s strokes immediately and does not redraw on the server echo', () => {
    vi.useFakeTimers()
    const sent: Array<{ commandId: string; op: DrawOperation }> = []
    const sync = new CanvasSync()
    sync.reset('t1')
    sync.setTransport({
      send: (_turnId, commandId, op) => {
        sent.push({ commandId, op })
        return new Promise<Ack>(() => undefined)
      },
    })
    sync.beginStroke('pen', '#0000ff', 10, [100, 100], 0)
    sync.addPoint([150, 120], 5)
    sync.addPoint([200, 160], 10)
    sync.endStroke()
    const drawn = sync.model.raster.hash()
    expect(sent.map((s) => s.op.type)).toEqual(['stroke.begin', 'stroke.points', 'stroke.end'])
    expect(sent[1]!.op).toMatchObject({ points: [[150, 120], [200, 160]] })

    const applySpy = vi.spyOn(sync.model, 'apply')
    sent.forEach((s, i) => sync.onRemote(accepted('t1', i + 1, s.op, 'a1', s.commandId)))
    expect(applySpy).not.toHaveBeenCalled()
    expect(sync.model.raster.hash()).toBe(drawn)
  })

  it('predicts action IDs for undo and drops a rejected operation', async () => {
    let reject: ((ack: Ack) => void) | null = null
    const sent: DrawOperation[] = []
    const sync = new CanvasSync()
    sync.reset('t1')
    sync.setTransport({
      send: (_turnId, commandId, op) => {
        sent.push(op)
        if (op.type === 'fill') return new Promise<Ack>((resolve) => (reject = resolve))
        return Promise.resolve({ commandId, ok: true })
      },
    })
    const blank = sync.model.raster.hash()
    sync.fill([10, 10], '#ff0000')
    expect(sync.model.raster.hash()).not.toBe(blank)
    reject!({ commandId: 'x', ok: false, code: 'RATE_LIMITED' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sync.model.raster.hash()).toBe(blank)

    sync.clear() // nothing to clear any more
    expect(sent.map((op) => op.type)).toEqual(['fill'])

    sync.beginStroke('pen', '#000000', 4, [5, 5], 0)
    sync.endStroke()
    expect(sync.undo()).toBe(true)
    expect(sent.at(-1)).toEqual({ type: 'undo', targetActionId: 'a1' })
  })

  it('splits very long gestures into several strokes', () => {
    const sent: DrawOperation[] = []
    const sync = new CanvasSync()
    sync.reset('t1')
    sync.setTransport({ send: (_t, commandId, op) => (sent.push(op), Promise.resolve({ commandId, ok: true })) })
    sync.beginStroke('pen', '#000000', 4, [0, 0], 0)
    sync.addPoint([1, 1], 1000)
    sync.addPoint([2, 2], 9500)
    sync.endStroke()
    expect(sent.filter((op) => op.type === 'stroke.begin')).toHaveLength(2)
    expect(sent.filter((op) => op.type === 'stroke.end')).toHaveLength(2)
  })
})
