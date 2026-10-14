import { useSyncExternalStore } from 'react'

/** Two routes do not need a router library: "/" and "/room/:code". */
export type Route = { name: 'home' } | { name: 'room'; code: string }

const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{16})\/?$/

export function parseRoute(pathname: string): Route {
  const match = ROOM_PATH.exec(pathname)
  return match ? { name: 'room', code: match[1]! } : { name: 'home' }
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return
  if (options.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  for (const listener of listeners) listener()
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

/** Accepts a full invite URL or a bare 16-character room code. */
export function roomCodeFromInput(input: string): string | null {
  const trimmed = input.trim()
  if (/^[A-Za-z0-9_-]{16}$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed, window.location.origin)
    const route = parseRoute(url.pathname)
    return route.name === 'room' ? route.code : null
  } catch {
    return null
  }
}
