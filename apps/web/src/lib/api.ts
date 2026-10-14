import type { Avatar, PublicRoomState, RoomSettings } from './protocol'

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let csrfToken = ''

function readCsrfCookie(): string {
  const match = /(?:^|;\s*)dg_csrf=([^;]+)/.exec(document.cookie)
  return match ? decodeURIComponent(match[1]!) : ''
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken || readCsrfCookie()
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.')
  }
  const data = (await res.json().catch(() => null)) as (T & { code?: string; message?: string; csrfToken?: string }) | null
  if (data && typeof data.csrfToken === 'string') csrfToken = data.csrfToken
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? 'HTTP_ERROR', data?.message ?? `Request failed (${res.status})`)
  }
  return data as T
}

export interface SessionInfo {
  name: string
  avatar: Avatar
}

export const api = {
  getSession: () => request<{ session: SessionInfo | null; csrfToken: string }>('GET', '/api/session'),
  saveSession: (displayName: string, avatar: Avatar) =>
    request<{ session: SessionInfo; csrfToken: string }>('POST', '/api/session', { displayName, avatar }),
  createRoom: () => request<{ code: string; invitePath: string; inviteUrl: string; playerId: string }>('POST', '/api/rooms'),
  getRoom: (code: string) =>
    request<{ playerId: string; state: PublicRoomState }>('GET', `/api/rooms/${encodeURIComponent(code)}`),
  joinRoom: (code: string) =>
    request<{ playerId: string; state: PublicRoomState | null }>('POST', `/api/rooms/${encodeURIComponent(code)}/join`),
  getHostSettings: (code: string) =>
    request<{ version: number; settings: RoomSettings }>('GET', `/api/rooms/${encodeURIComponent(code)}/settings`),
  saveSettings: (code: string, version: number, settings: RoomSettings) =>
    request<{ version: number; settings: RoomSettings }>('PUT', `/api/rooms/${encodeURIComponent(code)}/settings`, {
      version,
      settings,
    }),
  replayIndex: (gameId: string) => request<ReplayIndex>('GET', `/api/games/${encodeURIComponent(gameId)}/replays`),
  replayPage: (turnId: string, afterSeq: number) =>
    request<ReplayPage>('GET', `/api/turns/${encodeURIComponent(turnId)}/replay?afterSeq=${afterSeq}`),
}

export interface ReplayIndex {
  gameId: string
  status: 'IN_PROGRESS' | 'FINISHED' | 'INTERRUPTED'
  turns: Array<{
    turnId: string
    round: number
    turnIndex: number
    drawer: { playerId: string; name: string }
    answer: string | null
    endReason: string | null
    durationMs: number | null
    operationCount: number
  }>
}

export interface ReplayPage {
  turnId: string
  ops: import('./protocol').AcceptedOperation[]
  nextAfterSeq: number | null
}
