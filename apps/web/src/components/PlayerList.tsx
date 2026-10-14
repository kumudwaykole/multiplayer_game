import { memo, useMemo } from 'react'
import type { PublicRoomState } from '../lib/protocol'
import { cx } from '../lib/toast'
import { Avatar } from './Avatar'

interface PlayerListProps {
  state: PublicRoomState
  playerId: string | null
}

/** Scoreboard: rank, name, points and avatar. Guessers turn green, the drawer holds a pencil. */
export const PlayerList = memo(function PlayerList({ state, playerId }: PlayerListProps) {
  const inGame = state.game !== null || state.phase === 'GAME_RESULT'
  const rows = useMemo(() => {
    const players = [...state.players]
    if (inGame) players.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    let rank = 0
    let previous: number | null = null
    return players.map((player, index) => {
      const score = player.score ?? 0
      if (score !== previous) {
        rank = index + 1
        previous = score
      }
      return { player, rank }
    })
  }, [state.players, inGame])

  return (
    <aside className="area-players panel flex min-h-0 flex-col overflow-hidden" aria-label="Players">
      <div className="relative min-h-0 flex-1">
        <ol className="scroll-thin absolute inset-0 overflow-y-auto">
          {rows.map(({ player, rank }, index) => {
            const me = player.id === playerId
            const drawing = player.role === 'drawer'
            return (
              <li
                key={player.id}
                className={cx(
                  'flex items-center gap-1.5 border-b border-line/60 px-1.5 py-1 transition-colors sm:gap-2 sm:px-2',
                  player.guessed ? 'bg-guessed' : index % 2 ? 'bg-panel-alt' : 'bg-white',
                  !player.present && 'opacity-45',
                )}
              >
                <span className="w-6 shrink-0 text-xs font-black text-muted sm:w-7 sm:text-sm">{inGame ? `#${rank}` : ''}</span>
                <div className="min-w-0 flex-1 text-center leading-tight">
                  <div className={cx('truncate text-sm font-extrabold sm:text-[0.95rem]', me && 'text-brand')}>
                    {player.name}
                    {me && ' (You)'}
                  </div>
                  <div className="text-xs font-bold text-ink/80">
                    {inGame ? `${player.score ?? 0} points` : player.isHost ? 'Host' : ' '}
                    {!player.connected && player.present && (
                      <span className="ml-1" title="Reconnecting">
                        · away
                      </span>
                    )}
                    {player.role === 'spectator' && <span className="ml-1">· watching</span>}
                  </div>
                </div>
                <Avatar
                  avatar={player.avatar}
                  size={40}
                  crown={player.isHost}
                  pencil={drawing}
                  className="shrink-0 overflow-visible max-sm:size-9"
                />
              </li>
            )
          })}
        </ol>
      </div>
    </aside>
  )
})
