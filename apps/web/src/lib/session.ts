import { api, type SessionInfo } from './api'
import type { Avatar } from './protocol'
import { Store } from './store'

export type SessionState =
  | { status: 'loading' }
  | { status: 'ready'; session: SessionInfo | null }
  | { status: 'error'; message: string }

export const sessionStore = new Store<SessionState>({ status: 'loading' })

let loading: Promise<void> | null = null

/** Loads the guest session once per page (also issues the CSRF cookie). */
export function loadSession(): Promise<void> {
  loading ??= api
    .getSession()
    .then(({ session }) => sessionStore.set({ status: 'ready', session }))
    .catch((err: Error) => {
      loading = null
      sessionStore.set({ status: 'error', message: err.message })
    })
  return loading
}

export async function saveSession(name: string, avatar: Avatar): Promise<SessionInfo> {
  const { session } = await api.saveSession(name, avatar)
  sessionStore.set({ status: 'ready', session })
  rememberAvatar(avatar)
  return session
}

const AVATAR_KEY = 'dd.avatar'

/** The avatar picked last time, so a returning player keeps their look. */
export function rememberedAvatar(): Avatar | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(AVATAR_KEY) ?? 'null')
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((n) => Number.isInteger(n) && n >= 0 && n < 64)) {
      return parsed as Avatar
    }
  } catch {
    // Storage can be unavailable (private mode); fall back to a random avatar.
  }
  return null
}

function rememberAvatar(avatar: Avatar): void {
  try {
    localStorage.setItem(AVATAR_KEY, JSON.stringify(avatar))
  } catch {
    // Not critical.
  }
}
