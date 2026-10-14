import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { BRUSH_SIZES } from '../drawing/palette'
import { navigate } from '../lib/router'
import { useStore } from '../lib/store'
import { cx } from '../lib/toast'
import { RoomConnection } from '../realtime/connection'
import { BoardOverlay } from './BoardOverlay'
import { Chat } from './Chat'
import { DrawingBoard, type BrushState } from './DrawingBoard'
import { LobbyPanel } from './LobbyPanel'
import { Logo } from './Logo'
import { PlayerList } from './PlayerList'
import { Toolbar } from './Toolbar'
import { TopBar } from './TopBar'

// The replay viewer is only needed at the end of a game; keep it out of the main bundle.
const ReplayDialog = lazy(() => import('./ReplayDialog'))

function FullScreenMessage({ title, detail, action }: { title: string; detail: string; action: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <section className="panel w-full max-w-md p-6 text-center" role="alert">
        <h2 className="text-2xl font-black">{title}</h2>
        <p className="mt-2 font-semibold text-muted">{detail}</p>
        <div className="mt-5 flex justify-center gap-2">{action}</div>
      </section>
    </main>
  )
}

export function RoomScreen({ code }: { code: string }) {
  // One connection per room page; the parent remounts this component when the code changes.
  const [connection] = useState(() => new RoomConnection(code))

  useEffect(() => {
    connection.connect()
    return () => connection.dispose()
  }, [connection])

  return <Room connection={connection} />
}

function Room({ connection }: { connection: RoomConnection }) {
  const view = useStore(connection.view)
  const [brush, setBrush] = useState<BrushState>({ tool: 'pen', color: '#000000', size: BRUSH_SIZES[1] })
  const [replayGame, setReplayGame] = useState<string | null>(null)

  const onUndo = useCallback(() => connection.canvas.undo(), [connection])
  const onClear = useCallback(() => connection.canvas.clear(), [connection])
  const onSend = useCallback((text: string) => connection.chat(text), [connection])
  const onLeave = useCallback(() => {
    void connection.leave().finally(() => navigate('/'))
  }, [connection])

  const state = view.state
  const gameId = state?.gameResult?.gameId ?? null
  const onShowReplays = useCallback(() => setReplayGame(gameId), [gameId])

  if (view.status === 'error') {
    return (
      <FullScreenMessage
        title="Disconnected"
        detail={view.error ?? 'You are no longer in this room.'}
        action={
          <>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Try again
            </button>
            <button type="button" className="btn btn-brand" onClick={() => navigate('/')}>
              Home
            </button>
          </>
        }
      />
    )
  }
  if (view.status === 'replaced') {
    return (
      <FullScreenMessage
        title="Open in another tab"
        detail="You are playing from another tab or window. Only one can be in control at a time."
        action={
          <button type="button" className="btn btn-play" onClick={() => connection.reclaim()}>
            Play here instead
          </button>
        }
      />
    )
  }
  if (!state) {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="animate-pulse text-xl font-black text-white">Joining the room…</p>
      </main>
    )
  }

  const me = state.players.find((p) => p.id === view.playerId)
  const turn = state.turn
  const amDrawer = turn?.drawerId === view.playerId && turn?.status !== 'ended'
  const canDraw = state.phase === 'DRAWING' && amDrawer && view.status === 'live'
  let lockedReason: string | null = null
  if (amDrawer && (state.phase === 'DRAWING' || state.phase === 'CHOOSING')) lockedReason = 'You are drawing - no hints!'
  else if (state.phase === 'DRAWING' && me?.guessed) lockedReason = 'You guessed it! Chat opens after the turn'
  const placeholder = state.phase === 'DRAWING' ? 'Type your guess…' : 'Say something…'

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[88rem] flex-col px-1.5 py-1.5 sm:px-3 sm:py-2 lg:px-4">
      <header className="mb-1.5 hidden justify-center lg:flex">
        <button type="button" onClick={onLeave} className="rounded-xl" aria-label="Doodle Dash - leave to home">
          <Logo size="sm" />
        </button>
      </header>
      {view.status !== 'live' && (
        <div className="mb-1.5 rounded-lg bg-sun px-3 py-1.5 text-center text-sm font-extrabold text-ink" role="status">
          {view.status === 'connecting' ? 'Connecting…' : 'Connection lost - reconnecting…'}
        </div>
      )}
      <div className="game-layout flex-1">
        <TopBar view={view} state={state} clock={connection.clock} onLeave={onLeave} />
        <div className={cx('area-board min-w-0', state.phase === 'LOBBY' && 'lg:min-h-[32rem]')}>
          {state.phase === 'LOBBY' ? (
            <LobbyPanel connection={connection} view={view} state={state} onShowReplays={onShowReplays} />
          ) : (
            <DrawingBoard sync={connection.canvas} canDraw={canDraw} brush={brush}>
              <BoardOverlay view={view} state={state} connection={connection} onShowReplays={onShowReplays} />
            </DrawingBoard>
          )}
        </div>
        <div className="area-tools min-w-0">
          {canDraw && <Toolbar brush={brush} onChange={setBrush} onUndo={onUndo} onClear={onClear} />}
        </div>
        <PlayerList state={state} playerId={view.playerId} />
        <Chat lines={view.chat} onSend={onSend} lockedReason={lockedReason} placeholder={placeholder} />
      </div>
      {replayGame && (
        <Suspense fallback={null}>
          <ReplayDialog gameId={replayGame} onClose={() => setReplayGame(null)} />
        </Suspense>
      )}
    </main>
  )
}
