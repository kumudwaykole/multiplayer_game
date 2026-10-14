import { memo, type ReactNode } from 'react'
import type { PublicRoomState } from '../lib/protocol'
import { cx } from '../lib/toast'
import { useCountdown } from '../lib/useCountdown'
import type { ServerClock } from '../realtime/clock'
import type { RoomView } from '../realtime/connection'

function Clock({ deadline, clock }: { deadline: number | null; clock: ServerClock }) {
  const seconds = useCountdown(deadline, clock)
  const urgent = seconds !== null && seconds <= 10 && seconds > 0
  return (
    <div className="relative grid size-12 shrink-0 place-items-center sm:size-14" aria-label={seconds === null ? undefined : `${seconds} seconds left`}>
      <svg viewBox="0 0 64 64" className={cx('absolute inset-0 size-full', urgent && 'animate-wiggle')} aria-hidden="true">
        <path d="M14 14l-6 6M50 14l6 6" stroke="#1d1f2b" strokeWidth="6" strokeLinecap="round" />
        <circle cx="32" cy="35" r="24" fill={urgent ? '#ef4a3f' : '#fff'} stroke="#1d1f2b" strokeWidth="5" />
      </svg>
      <span className={cx('relative mt-1.5 text-lg font-black tabular-nums sm:text-xl', urgent && 'text-white')}>
        {seconds ?? '–'}
      </span>
    </div>
  )
}

/** Hidden letters as underlines, revealed letters in place, and the word lengths. */
function MaskedWord({ mask }: { mask: string }) {
  const lengths = mask.split(' ').map((w) => w.length)
  return (
    <span className="inline-flex flex-wrap items-end justify-center gap-y-1" aria-label={`${lengths.join(' and ')} letters`}>
      {[...mask].map((ch, i) =>
        ch === ' ' ? (
          <span key={i} className="w-3 sm:w-4" />
        ) : (
          <span
            key={i}
            className={cx(
              'mx-[0.08em] inline-block w-[0.85em] text-center leading-none',
              ch === '_' ? 'border-b-[3px] border-ink' : 'uppercase',
            )}
          >
            {ch === '_' ? ' ' : ch}
          </span>
        ),
      )}
      <sup className="ml-1.5 text-xs font-extrabold text-muted sm:text-sm">{lengths.join(' ')}</sup>
    </span>
  )
}

/** Puts the letters a correct guesser typed into the mask's letter slots. */
function fillMask(mask: string, key: string): string {
  let i = 0
  return [...mask].map((ch) => (/[_a-z0-9]/i.test(ch) ? (key[i++] ?? ch) : ch)).join('')
}

function WordArea({ state, view }: { state: PublicRoomState; view: RoomView }) {
  const turn = state.turn
  const me = view.playerId
  const drawer = turn ? state.players.find((p) => p.id === turn.drawerId) : undefined
  let label = 'Waiting'
  let content: ReactNode = <span className="text-base text-muted sm:text-lg">Waiting for the game to start…</span>

  if (state.phase === 'CHOOSING' && turn) {
    content =
      turn.drawerId === me ? (
        <span className="text-base sm:text-lg">Choose a word!</span>
      ) : (
        <span className="text-base sm:text-lg">{drawer?.name ?? 'Someone'} is choosing a word…</span>
      )
  } else if (state.phase === 'DRAWING' && turn?.mask) {
    if (turn.drawerId === me && view.secret?.word) {
      label = 'Draw this'
      content = <MaskedWord mask={view.secret.word} />
    } else if (view.solved?.turnId === turn.id) {
      label = 'You got it!'
      content = <MaskedWord mask={fillMask(turn.mask, view.solved.key)} />
    } else {
      label = 'Guess this'
      content = <MaskedWord mask={turn.mask} />
    }
  } else if (state.phase === 'TURN_RESULT' && state.turnResult) {
    label = 'The word was'
    content = state.turnResult.answer ? <MaskedWord mask={state.turnResult.answer} /> : <span className="text-lg">—</span>
  } else if (state.phase === 'GAME_RESULT') {
    label = 'Game over'
    content = <span className="text-base sm:text-lg">Thanks for playing!</span>
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
      <span className="text-[0.65rem] font-black tracking-[0.2em] text-muted uppercase sm:text-xs">{label}</span>
      <div className="text-xl font-black sm:text-2xl lg:text-[1.7rem]">{content}</div>
    </div>
  )
}

interface TopBarProps {
  view: RoomView
  state: PublicRoomState
  clock: ServerClock
  onLeave: () => void
}

export const TopBar = memo(function TopBar({ view, state, clock, onLeave }: TopBarProps) {
  const turn = state.turn
  const deadline =
    state.phase === 'DRAWING' ? (turn?.deadline ?? null) : state.phase === 'CHOOSING' ? (turn?.choosingDeadline ?? null) : null
  const round = state.game?.round ?? 0
  const total = state.game?.totalRounds ?? state.settings.rounds

  return (
    <div className="area-top panel flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3">
      <Clock deadline={deadline} clock={clock} />
      <div className="hidden text-sm leading-tight font-extrabold whitespace-nowrap sm:block">
        {state.game ? (
          <>
            Round <span className="text-lg font-black">{round}</span> of {total}
          </>
        ) : state.phase === 'GAME_RESULT' ? (
          <>Final</>
        ) : (
          <>Lobby</>
        )}
      </div>
      <WordArea state={state} view={view} />
      <span className="text-xs font-extrabold whitespace-nowrap sm:hidden">{state.game ? `${round}/${total}` : ''}</span>
      <button type="button" onClick={onLeave} className="btn btn-danger shrink-0 px-2.5 py-2 text-sm" aria-label="Leave room" title="Leave room">
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M9 16l-4-4 4-4M5 12h11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  )
})
