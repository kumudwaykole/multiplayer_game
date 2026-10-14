import { useState, type FormEvent } from 'react'
import { Avatar } from '../components/Avatar'
import { Logo } from '../components/Logo'
import { ProfilePanel, type SaveProfile } from '../components/ProfilePanel'
import { api } from '../lib/api'
import type { Avatar as AvatarParts } from '../lib/protocol'
import { navigate, roomCodeFromInput } from '../lib/router'
import { markProfileConfirmed } from './profileFlag'

const PARADE: AvatarParts[] = [
  [0, 0, 0], [2, 1, 1], [4, 2, 4], [7, 5, 8], [9, 6, 10], [11, 2, 0], [5, 10, 7], [13, 8, 11],
]

const STEPS = [
  { title: 'Create a room', text: 'Pick a name and avatar, then share the invite link with friends.', color: 'bg-brand' },
  { title: 'Draw your word', text: 'On your turn, choose one of three words and draw it for everyone.', color: 'bg-play' },
  { title: 'Guess fast', text: 'Type guesses in the chat. Faster correct guesses earn more points!', color: 'bg-sun' },
]

function JoinByLink({ saveProfile }: { saveProfile: SaveProfile }) {
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const code = roomCodeFromInput(link)
    if (!code) {
      setError('That does not look like an invite link.')
      return
    }
    if (!(await saveProfile())) return
    markProfileConfirmed()
    navigate(`/room/${code}`)
  }

  return (
    <>
      <div className="my-4 flex items-center gap-3 text-sm font-extrabold text-muted uppercase">
        <span className="h-0.5 flex-1 bg-line" />
        or join a friend
        <span className="h-0.5 flex-1 bg-line" />
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="invite" className="sr-only">
          Invite link or room code
        </label>
        <input
          id="invite"
          className="field min-w-0 flex-1"
          placeholder="Paste invite link"
          value={link}
          onChange={(e) => {
            setLink(e.target.value)
            setError(null)
          }}
        />
        <button type="submit" className="btn btn-brand">
          Join
        </button>
      </form>
      {error && <p className="mt-2 text-sm font-bold text-danger">{error}</p>}
    </>
  )
}

export function HomePage() {
  const createRoom = async () => {
    const room = await api.createRoom()
    markProfileConfirmed()
    navigate(room.invitePath)
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col items-center px-4 pt-8 pb-16">
      <Logo />
      <div className="mt-3 mb-6 flex gap-1 sm:gap-2" aria-hidden="true">
        {PARADE.map((avatar, i) => (
          <span key={i} className="animate-wiggle" style={{ animationDelay: `${i * -0.17}s` }}>
            <Avatar avatar={avatar} size={44} />
          </span>
        ))}
      </div>

      <ProfilePanel primaryLabel="Create room!" onPrimary={createRoom}>
        {(saveProfile) => <JoinByLink saveProfile={saveProfile} />}
      </ProfilePanel>

      <section className="mt-10 grid w-full gap-4 sm:grid-cols-3" aria-label="How to play">
        {STEPS.map((step, i) => (
          <article key={step.title} className="panel p-4">
            <div className="flex items-center gap-3">
              <span
                className={`grid size-9 shrink-0 place-items-center rounded-full ${step.color} text-lg font-black text-white shadow-[0_3px_0_rgb(0_0_0/0.2)]`}
              >
                {i + 1}
              </span>
              <h2 className="text-lg font-black">{step.title}</h2>
            </div>
            <p className="mt-2 font-semibold text-muted">{step.text}</p>
          </article>
        ))}
      </section>
    </main>
  )
}
