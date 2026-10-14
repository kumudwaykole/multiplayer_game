import { useEffect, useMemo, useRef, useState } from 'react'
import { CanvasModel } from '../drawing/canvasModel'
import { api, type ReplayIndex } from '../lib/api'
import type { AcceptedOperation } from '../lib/protocol'
import { cx } from '../lib/toast'
import { CanvasView } from './CanvasView'

const SPEEDS = [0.5, 1, 2] as const

async function loadAllOps(turnId: string): Promise<AcceptedOperation[]> {
  const ops: AcceptedOperation[] = []
  let after = 0
  for (;;) {
    const page = await api.replayPage(turnId, after)
    ops.push(...page.ops)
    if (page.nextAfterSeq === null) return ops
    after = page.nextAfterSeq
  }
}

/** Plays one drawing back stroke by stroke, with the original timing. */
function Player({ turnId }: { turnId: string }) {
  const model = useMemo(() => new CanvasModel(), [])
  const [ops, setOps] = useState<AcceptedOperation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [position, setPosition] = useState(0)
  const cursor = useRef({ time: 0, next: 0 })

  // The parent keys this component by turn, so every turn starts from fresh state.
  useEffect(() => {
    let cancelled = false
    loadAllOps(turnId)
      .then((loaded) => {
        if (cancelled) return
        // Skip the idle time before the first stroke (choosing, thinking).
        const lead = Math.max(0, (loaded[0]?.elapsedMs ?? 0) - 300)
        setOps(loaded.map((op) => ({ ...op, elapsedMs: op.elapsedMs - lead })))
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [turnId])

  const duration = ops && ops.length > 0 ? ops[ops.length - 1]!.elapsedMs + 600 : 0
  const finished = duration > 0 && position >= duration

  // Apply every operation up to the playback time.
  const advanceTo = (time: number) => {
    if (!ops) return
    const c = cursor.current
    if (time < c.time) {
      // Seeking back: rebuild from the start (the model is fast at this).
      c.next = 0
      model.reset()
    }
    while (c.next < ops.length && ops[c.next]!.elapsedMs <= time) {
      const op = ops[c.next]!
      model.apply(op.operation, op.actionId)
      c.next++
    }
    c.time = time
  }

  useEffect(() => {
    if (!ops || !playing) return
    let frame = 0
    let last = performance.now()
    let lastUi = 0
    const tick = (now: number) => {
      const time = Math.min(duration, cursor.current.time + (now - last) * speed)
      last = now
      advanceTo(time)
      if (now - lastUi > 100 || time >= duration) {
        lastUi = now
        setPosition(time)
      }
      if (time >= duration) {
        setPlaying(false)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops, playing, speed, duration])

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-[10/7] w-full overflow-hidden rounded-xl border-2 border-line bg-white">
        <CanvasView model={model} className="absolute inset-0 size-full" label="Drawing replay" />
        {!ops && !error && <p className="absolute inset-0 grid place-items-center font-bold text-muted">Loading…</p>}
        {error && <p className="absolute inset-0 grid place-items-center font-bold text-danger">{error}</p>}
        {ops?.length === 0 && <p className="absolute inset-0 grid place-items-center font-bold text-muted">Nothing was drawn.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-play px-3 py-1.5"
          disabled={!ops || ops.length === 0}
          onClick={() => {
            if (!playing && finished) {
              advanceTo(0)
              setPosition(0)
            }
            setPlaying(!playing)
          }}
        >
          {playing ? 'Pause' : finished ? 'Replay' : 'Play'}
        </button>
        <input
          type="range"
          aria-label="Replay position"
          className="min-w-24 flex-1 accent-brand"
          min={0}
          max={duration || 1}
          step={50}
          value={position}
          disabled={!ops || ops.length === 0}
          onChange={(e) => {
            const time = Number(e.target.value)
            advanceTo(time)
            setPosition(time)
          }}
        />
        <div className="flex gap-1" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={speed === s}
              className={cx('rounded-lg border-2 px-2 py-1 text-sm font-extrabold', speed === s ? 'border-ink bg-sun' : 'border-line')}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Modal with every drawing from a game. Closes on Esc or a click outside. */
export default function ReplayDialog({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [index, setIndex] = useState<ReplayIndex | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    dialog.showModal()
    // Light dismiss for browsers without the closedby attribute.
    const fallback = (event: MouseEvent) => {
      if (event.target !== dialog) return
      const r = dialog.getBoundingClientRect()
      const inside = r.top <= event.clientY && event.clientY <= r.bottom && r.left <= event.clientX && event.clientX <= r.right
      if (!inside) dialog.close()
    }
    const supportsClosedBy = 'closedBy' in HTMLDialogElement.prototype
    if (!supportsClosedBy) dialog.addEventListener('click', fallback)
    return () => dialog.removeEventListener('click', fallback)
  }, [])

  useEffect(() => {
    api
      .replayIndex(gameId)
      .then((result) => {
        setIndex(result)
        setSelected(result.turns.find((t) => t.operationCount > 0)?.turnId ?? result.turns[0]?.turnId ?? null)
      })
      .catch((err: Error) => setError(err.message))
  }, [gameId])

  return (
    <dialog
      ref={ref}
      closedby="any"
      onClose={onClose}
      aria-labelledby="replay-title"
      className="m-auto w-[min(56rem,calc(100vw-1rem))] max-w-none rounded-2xl bg-white p-0 text-ink shadow-[0_6px_0_rgb(0_0_0/0.3)]"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 overflow-y-auto p-3 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="replay-title" className="text-xl font-black sm:text-2xl">
            Drawing replays
          </h2>
          <button type="button" className="btn px-3 py-1.5" onClick={() => ref.current?.close()}>
            Close
          </button>
        </div>
        {error && <p className="font-bold text-danger">{error}</p>}
        {index && index.turns.length === 0 && <p className="font-bold text-muted">No finished drawings yet.</p>}
        {index && index.turns.length > 0 && (
          <div className="grid gap-3 md:grid-cols-[13rem_1fr]">
            <ul className="scroll-thin flex gap-2 overflow-x-auto md:max-h-[28rem] md:flex-col md:overflow-y-auto">
              {index.turns.map((turn) => (
                <li key={turn.turnId} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setSelected(turn.turnId)}
                    aria-pressed={selected === turn.turnId}
                    className={cx(
                      'w-full rounded-xl border-2 px-3 py-2 text-left',
                      selected === turn.turnId ? 'border-ink bg-sun' : 'border-line hover:border-ink/40',
                    )}
                  >
                    <span className="block text-xs font-bold text-muted">Round {turn.round}</span>
                    <span className="block font-extrabold">{turn.drawer.name}</span>
                    <span className="block text-sm font-bold">{turn.answer ? `'${turn.answer}'` : 'no word'}</span>
                  </button>
                </li>
              ))}
            </ul>
            {selected && <Player key={selected} turnId={selected} />}
          </div>
        )}
      </div>
    </dialog>
  )
}
