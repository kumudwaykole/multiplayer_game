import { memo, type ReactNode } from 'react'
import type { PublicRoomState, RankedPlayer, TurnEndReason } from '../lib/protocol'
import { cx, toast } from '../lib/toast'
import { useCountdown } from '../lib/useCountdown'
import type { RoomConnection, RoomView } from '../realtime/connection'
import { Avatar } from './Avatar'

const REASONS: Record<TurnEndReason, string> = {
  TIME_UP: 'Time is up!',
  ALL_GUESSED: 'Everybody guessed the word!',
  DRAWER_DISCONNECTED: 'The drawer disconnected.',
  DRAWER_LEFT: 'The drawer left the game.',
  NO_GUESSERS: 'Nobody is left to guess.',
  NOT_ENOUGH_PLAYERS: 'Not enough players to continue.',
  SERVER_RESTART: 'The server restarted.',
  PERSISTENCE_FAILURE: 'Something went wrong on the server.',
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center overflow-y-auto rounded-[inherit] bg-overlay p-3 text-white">
      <div className="animate-pop flex w-full max-w-lg flex-col items-center gap-3 text-center">{children}</div>
    </div>
  )
}

function WordChoices({ view, connection, state }: { view: RoomView; connection: RoomConnection; state: PublicRoomState }) {
  const seconds = useCountdown(state.turn?.choosingDeadline ?? null, connection.clock)
  const secret = view.secret
  if (!secret?.choices) return null
  return (
    <Shell>
      <h2 className="text-2xl font-black sm:text-3xl">Choose a word</h2>
      <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
        {secret.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="btn bg-white px-4 py-2.5 text-lg text-ink sm:px-5 sm:text-xl"
            onClick={() =>
              void connection.selectWord(secret.turnId, choice.id).then((ack) => {
                if (!ack.ok) toast(ack.message ?? 'Could not pick that word, try again', 'error')
              })
            }
          >
            {choice.word}
          </button>
        ))}
      </div>
      {seconds !== null && <p className="font-bold text-white/75">A word is picked for you in {seconds}s</p>}
    </Shell>
  )
}

function Choosing({ state }: { state: PublicRoomState }) {
  const drawer = state.players.find((p) => p.id === state.turn?.drawerId)
  return (
    <Shell>
      {state.game && (
        <p className="text-lg font-black tracking-widest text-sun uppercase">
          Round {state.game.round} of {state.game.totalRounds}
        </p>
      )}
      {drawer && (
        <span className="animate-wiggle">
          <Avatar avatar={drawer.avatar} size={84} pencil />
        </span>
      )}
      <h2 className="text-xl font-black sm:text-2xl">{drawer?.name ?? 'Someone'} is choosing a word!</h2>
    </Shell>
  )
}

function TurnResultCard({ state }: { state: PublicRoomState }) {
  const result = state.turnResult!
  const drawer = state.players.find((p) => p.id === result.drawerId)
  const points = new Map(result.deltas.map((d) => [d.playerId, d.points]))
  const rows = state.players
    .filter((p) => p.present || points.has(p.id))
    .map((p) => ({ player: p, points: points.get(p.id) ?? 0 }))
    .sort((a, b) => b.points - a.points)
  return (
    <Shell>
      <p className="text-lg font-extrabold text-white/85">{REASONS[result.reason]}</p>
      {result.answer ? (
        <h2 className="text-2xl font-black sm:text-3xl">
          The word was <span className="text-sun">'{result.answer}'</span>
        </h2>
      ) : (
        <h2 className="text-xl font-black">{drawer?.name ?? 'The drawer'} did not pick a word.</h2>
      )}
      <ul className="grid w-full max-w-xs gap-1 text-left">
        {rows.map(({ player, points: earned }) => (
          <li key={player.id} className="flex items-center justify-between gap-3 text-base font-extrabold sm:text-lg">
            <span className="truncate">{player.name}</span>
            <span className={cx('tabular-nums', earned > 0 ? 'text-play' : 'text-danger')}>
              {earned > 0 ? `+${earned}` : '0'}
            </span>
          </li>
        ))}
      </ul>
    </Shell>
  )
}

function Podium({ ranking }: { ranking: RankedPlayer[] }) {
  const top = ranking.slice(0, 3)
  // Classic podium order: 2nd, 1st, 3rd.
  const order = [top[1], top[0], top[2]].filter((p): p is RankedPlayer => !!p)
  const heights: Record<number, string> = { 1: 'h-20 sm:h-24', 2: 'h-14 sm:h-16', 3: 'h-10 sm:h-12' }
  return (
    <div className="flex items-end justify-center gap-2 sm:gap-4">
      {order.map((p) => (
        <div key={p.playerId} className="flex w-20 flex-col items-center sm:w-28">
          <Avatar avatar={p.avatar} size={p.rank === 1 ? 72 : 56} crown={p.rank === 1} className="overflow-visible" />
          <span className="mt-1 w-full truncate text-sm font-extrabold sm:text-base">{p.name}</span>
          <span className="text-xs font-bold text-white/75">{p.score} pts</span>
          <div
            className={cx(
              'mt-1 grid w-full place-items-center rounded-t-lg text-2xl font-black text-ink',
              heights[p.rank] ?? 'h-8',
              p.rank === 1 ? 'bg-sun' : p.rank === 2 ? 'bg-[#d9dde8]' : 'bg-[#e0a46a]',
            )}
          >
            {p.rank}
          </div>
        </div>
      ))}
    </div>
  )
}

function GameResultCard({
  state,
  view,
  connection,
  onShowReplays,
}: {
  state: PublicRoomState
  view: RoomView
  connection: RoomConnection
  onShowReplays: () => void
}) {
  const result = state.gameResult!
  const isHost = state.hostId === view.playerId
  const rest = result.ranking.slice(3)
  return (
    <Shell>
      <h2 className="text-2xl font-black sm:text-3xl">{result.status === 'FINISHED' ? 'Game over!' : 'Game interrupted'}</h2>
      <Podium ranking={result.ranking} />
      {rest.length > 0 && (
        <ol className="grid w-full max-w-xs gap-0.5 text-left text-sm font-bold">
          {rest.map((p) => (
            <li key={p.playerId} className="flex justify-between">
              <span>
                #{p.rank} {p.name}
              </span>
              <span>{p.score} pts</span>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" className="btn btn-brand" onClick={onShowReplays}>
          Watch the drawings
        </button>
        {isHost ? (
          <button type="button" className="btn btn-play" onClick={() => void connection.returnToLobby()}>
            Play again
          </button>
        ) : (
          <span className="self-center text-sm font-bold text-white/75">Waiting for the host…</span>
        )}
      </div>
    </Shell>
  )
}

interface BoardOverlayProps {
  view: RoomView
  state: PublicRoomState
  connection: RoomConnection
  onShowReplays: () => void
}

/** What sits on top of the canvas between and around turns. */
export const BoardOverlay = memo(function BoardOverlay({ view, state, connection, onShowReplays }: BoardOverlayProps) {
  const turn = state.turn
  if (state.phase === 'CHOOSING' && turn) {
    return turn.drawerId === view.playerId ? (
      <WordChoices view={view} connection={connection} state={state} />
    ) : (
      <Choosing state={state} />
    )
  }
  if (state.phase === 'TURN_RESULT' && state.turnResult) return <TurnResultCard state={state} />
  if (state.phase === 'GAME_RESULT' && state.gameResult) {
    return <GameResultCard state={state} view={view} connection={connection} onShowReplays={onShowReplays} />
  }
  if (state.phase === 'DRAWING') {
    const me = state.players.find((p) => p.id === view.playerId)
    if (me?.role === 'spectator') {
      return (
        <div className="absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-xs font-bold text-white">
          Watching this turn - you can guess from the next one
        </div>
      )
    }
  }
  return null
})
