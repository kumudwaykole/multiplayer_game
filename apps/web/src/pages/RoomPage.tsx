import { useEffect, useState } from 'react'
import { Logo } from '../components/Logo'
import { ProfilePanel } from '../components/ProfilePanel'
import { RoomScreen } from '../components/RoomScreen'
import { ApiError, api } from '../lib/api'
import { navigate } from '../lib/router'
import { sessionStore } from '../lib/session'
import { useStore } from '../lib/store'
import { isProfileConfirmed, markProfileConfirmed } from './profileFlag'

type Stage = { name: 'checking' } | { name: 'gate' } | { name: 'joined' } | { name: 'error'; title: string; detail: string }

const JOIN_ERRORS: Record<string, { title: string; detail: string }> = {
  ROOM_NOT_FOUND: { title: 'Room not found', detail: 'This invite link does not lead to an open room.' },
  ROOM_CLOSED: { title: 'Room closed', detail: 'Everyone left and the room was closed.' },
  ROOM_FULL: { title: 'Room is full', detail: 'Ask the host to raise the player limit, or try again later.' },
  SERVER_DRAINING: { title: 'Server restarting', detail: 'Give it a few seconds and try again.' },
}

function errorStage(err: unknown): Stage {
  const known = err instanceof ApiError ? JOIN_ERRORS[err.code] : undefined
  if (known) return { name: 'error', ...known }
  return { name: 'error', title: 'Could not join', detail: err instanceof Error ? err.message : 'Please try again.' }
}

export function RoomPage({ code }: { code: string }) {
  const session = useStore(sessionStore)
  const [stage, setStage] = useState<Stage>({ name: 'checking' })

  const join = async () => {
    try {
      await api.joinRoom(code)
      setStage({ name: 'joined' })
    } catch (err) {
      setStage(errorStage(err))
    }
  }

  useEffect(() => {
    if (session.status !== 'ready' || stage.name !== 'checking') return
    let cancelled = false
    void (async () => {
      if (!session.session) {
        if (!cancelled) setStage({ name: 'gate' })
        return
      }
      if (isProfileConfirmed()) {
        await join()
        return
      }
      // Coming back (refresh, reconnect): members go straight back in.
      try {
        await api.getRoom(code)
        if (!cancelled) await join()
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.code === 'NOT_MEMBER') setStage({ name: 'gate' })
        else setStage(errorStage(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, stage.name, code])

  if (stage.name === 'joined') return <RoomScreen code={code} />

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center px-4 pt-8 pb-16">
      <button type="button" onClick={() => navigate('/')} className="rounded-xl" aria-label="Back to the home page">
        <Logo />
      </button>
      <div className="mt-8 flex w-full justify-center">
        {stage.name === 'gate' && (
          <ProfilePanel
            primaryLabel="Join room!"
            onPrimary={async () => {
              markProfileConfirmed()
              await join()
            }}
          />
        )}
        {(stage.name === 'checking' || session.status === 'loading') && stage.name !== 'gate' && (
          <p className="animate-pulse text-xl font-black text-white">Finding your room…</p>
        )}
        {stage.name === 'error' && (
          <section className="panel w-full max-w-md p-6 text-center" role="alert">
            <h2 className="text-2xl font-black">{stage.title}</h2>
            <p className="mt-2 font-semibold text-muted">{stage.detail}</p>
            <button type="button" className="btn btn-brand mt-5" onClick={() => navigate('/')}>
              Back to home
            </button>
          </section>
        )}
        {session.status === 'error' && (
          <section className="panel w-full max-w-md p-6 text-center" role="alert">
            <h2 className="text-2xl font-black">Cannot reach the server</h2>
            <p className="mt-2 font-semibold text-muted">{session.message}</p>
            <button type="button" className="btn btn-brand mt-5" onClick={() => window.location.reload()}>
              Try again
            </button>
          </section>
        )}
      </div>
    </main>
  )
}
