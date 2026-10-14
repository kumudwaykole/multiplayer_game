import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../lib/api'
import type { Avatar as AvatarParts } from '../lib/protocol'
import { NAME_MAX_CHARS } from '../lib/protocol'
import { rememberedAvatar, saveSession, sessionStore } from '../lib/session'
import { useStore } from '../lib/store'
import { AvatarEditor } from './AvatarEditor'
import { randomAvatar } from './avatarParts'

/** Saves the typed name and avatar. Resolves false (and shows why) when it cannot. */
export type SaveProfile = () => Promise<boolean>

interface ProfilePanelProps {
  primaryLabel: string
  /** Runs after the name and avatar are saved. */
  onPrimary: () => Promise<void> | void
  /** Extra actions under the main button; they can save the profile first. */
  children?: (saveProfile: SaveProfile) => ReactNode
}

/** Name + avatar card with the big green button, as on the home screen. */
export function ProfilePanel(props: ProfilePanelProps) {
  const status = useStore(sessionStore).status
  // Remount once the session has loaded so the saved name and avatar prefill the form.
  return <ProfileForm key={status} {...props} />
}

function ProfileForm({ primaryLabel, onPrimary, children }: ProfilePanelProps) {
  const session = useStore(sessionStore)
  const existing = session.status === 'ready' ? session.session : null
  const [name, setName] = useState(existing?.name ?? '')
  const [avatar, setAvatar] = useState<AvatarParts>(() => existing?.avatar ?? rememberedAvatar() ?? randomAvatar())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveProfile: SaveProfile = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Pick a name first!')
      document.getElementById('player-name')?.focus()
      return false
    }
    try {
      await saveSession(trimmed, avatar)
      setError(null)
      return true
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
      return false
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      if (await saveProfile()) await onPrimary()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel w-full max-w-md p-4 sm:p-5" aria-label="Your player">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="sr-only" htmlFor="player-name">
          Your name
        </label>
        <input
          id="player-name"
          className="field text-lg"
          placeholder="Enter your name"
          autoComplete="nickname"
          maxLength={NAME_MAX_CHARS}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={session.status === 'loading'}
        />
        <AvatarEditor value={avatar} onChange={setAvatar} />
        {error && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-bold text-danger" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-play py-3 text-2xl" disabled={busy || session.status === 'loading'}>
          {busy ? 'One moment…' : primaryLabel}
        </button>
      </form>
      {children?.(saveProfile)}
    </section>
  )
}
