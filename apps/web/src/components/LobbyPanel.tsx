import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, api } from '../lib/api'
import type { PublicRoomState, RoomSettings } from '../lib/protocol'
import { toast } from '../lib/toast'
import type { RoomConnection, RoomView } from '../realtime/connection'

const PLAYER_OPTIONS = Array.from({ length: 10 }, (_, i) => i + 3)
const DRAW_TIME_OPTIONS = [30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 180]
const ROUND_OPTIONS = Array.from({ length: 10 }, (_, i) => i + 1)
const MIN_CUSTOM_WORDS = 10

function parseWords(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean)
}

function Row({ icon, label, htmlFor, children }: { icon: string; label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-7 text-center text-xl" aria-hidden="true">
        {icon}
      </span>
      <label htmlFor={htmlFor} className="flex-1 font-extrabold">
        {label}
      </label>
      <div className="w-36 sm:w-44">{children}</div>
    </div>
  )
}

interface LobbyPanelProps {
  connection: RoomConnection
  view: RoomView
  state: PublicRoomState
  onShowReplays: () => void
}

/** Room settings, invite link and the start button (fills the canvas area in the lobby). */
export function LobbyPanel({ connection, view, state, onShowReplays }: LobbyPanelProps) {
  const isHost = state.hostId === view.playerId
  const hostSettings = isHost ? view.hostSettings : null
  const versionRef = useRef(state.settingsVersion)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const [wordsDraft, setWordsDraft] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    versionRef.current = Math.max(versionRef.current, state.settingsVersion)
  }, [state.settingsVersion])

  // A new host does not have the private settings yet.
  useEffect(() => {
    if (!isHost || view.hostSettings) return
    api
      .getHostSettings(connection.code)
      .then((r) => {
        versionRef.current = Math.max(versionRef.current, r.version)
        connection.setHostSettings(r.settings)
      })
      .catch(() => undefined)
  }, [isHost, view.hostSettings, connection])

  const reload = async () => {
    const fresh = await api.getHostSettings(connection.code)
    versionRef.current = fresh.version
    connection.setHostSettings(fresh.settings)
  }

  /** Saves in order; on a version conflict the latest settings are reloaded. */
  const save = (patch: Partial<RoomSettings>) => {
    if (!hostSettings) return
    const next: RoomSettings = { ...hostSettings, ...patch }
    connection.setHostSettings(next)
    queue.current = queue.current.then(async () => {
      try {
        const saved = await api.saveSettings(connection.code, versionRef.current, next)
        versionRef.current = saved.version
        connection.setHostSettings(saved.settings)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'SETTINGS_CONFLICT') toast('Settings changed elsewhere - reloaded', 'info')
        else toast(err instanceof Error ? err.message : 'Could not save settings', 'error')
        await reload().catch(() => undefined)
      }
    })
  }

  const settings = state.settings
  const shown = hostSettings ?? { ...settings, customWords: [] }
  const words = wordsDraft ?? hostSettings?.customWords.join(', ') ?? ''
  const parsedWords = parseWords(words)

  const commitWords = (useCustom: boolean) => {
    const list = parseWords(words)
    if (useCustom && list.length < MIN_CUSTOM_WORDS) {
      toast(`Add at least ${MIN_CUSTOM_WORDS} words to use your own list`, 'error')
      return
    }
    save({
      wordMode: useCustom ? 'custom' : 'builtin',
      customWords: list.length >= MIN_CUSTOM_WORDS ? list : [],
    })
    setWordsDraft(null)
  }

  const online = state.players.filter((p) => p.connected).length
  const canStart = online >= state.minPlayers
  const inviteUrl = `${window.location.origin}/room/${state.code}`

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      toast('Invite link copied!', 'success')
    } catch {
      const input = document.getElementById('invite-link') as HTMLInputElement | null
      input?.select()
      toast('Press Ctrl+C to copy the link', 'info')
    }
  }

  const start = async () => {
    setStarting(true)
    const ack = await connection.startGame()
    setStarting(false)
    if (!ack.ok) toast(ack.message ?? 'Could not start the game', 'error')
  }

  const disabled = !isHost || !hostSettings

  return (
    <section className="panel flex min-h-full flex-col gap-4 p-4 sm:p-5" aria-label="Room settings">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black sm:text-2xl">{isHost ? 'Room settings' : 'Waiting for the host…'}</h2>
        {!isHost && <p className="text-sm font-bold text-muted">Only the host can change these.</p>}
      </div>

      {state.gameResult && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-panel-alt px-3 py-2">
          <p className="font-bold">
            {state.gameResult.status === 'FINISHED' ? 'Last game won by ' : 'Last game was interrupted. Leader: '}
            <b>{state.gameResult.ranking[0]?.name ?? '-'}</b>
          </p>
          <button type="button" className="btn btn-brand px-3 py-1.5 text-sm" onClick={onShowReplays}>
            Watch the drawings
          </button>
        </div>
      )}

      <div className="grid gap-3">
        <Row icon="👥" label="Players" htmlFor="set-players">
          <select
            id="set-players"
            className="field py-1.5"
            value={shown.maxPlayers}
            disabled={disabled}
            onChange={(e) => save({ maxPlayers: Number(e.target.value) })}
          >
            {PLAYER_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
        <Row icon="⏱️" label="Draw time" htmlFor="set-time">
          <select
            id="set-time"
            className="field py-1.5"
            value={shown.drawTimeSec}
            disabled={disabled}
            onChange={(e) => save({ drawTimeSec: Number(e.target.value) })}
          >
            {DRAW_TIME_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>
        </Row>
        <Row icon="🔁" label="Rounds" htmlFor="set-rounds">
          <select
            id="set-rounds"
            className="field py-1.5"
            value={shown.rounds}
            disabled={disabled}
            onChange={(e) => save({ rounds: Number(e.target.value) })}
          >
            {ROUND_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Row>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="set-words" className="font-extrabold">
            📝 Custom words
          </label>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input
              type="checkbox"
              className="size-4 accent-brand"
              checked={shown.wordMode === 'custom'}
              disabled={disabled}
              onChange={(e) => commitWords(e.target.checked)}
            />
            Use custom words only
          </label>
        </div>
        {isHost ? (
          <>
            <textarea
              id="set-words"
              className="field min-h-24 resize-y text-sm"
              placeholder="Minimum of 10 words, 2-32 characters each, separated by commas"
              value={words}
              disabled={disabled}
              onChange={(e) => setWordsDraft(e.target.value)}
              onBlur={() => wordsDraft !== null && commitWords(shown.wordMode === 'custom')}
            />
            <p className="text-xs font-bold text-muted">
              {parsedWords.length} word{parsedWords.length === 1 ? '' : 's'}
              {parsedWords.length > 0 && parsedWords.length < MIN_CUSTOM_WORDS && ` - add ${MIN_CUSTOM_WORDS - parsedWords.length} more`}
            </p>
          </>
        ) : (
          <p id="set-words" className="rounded-lg bg-panel-alt px-3 py-2 text-sm font-bold text-muted">
            {settings.wordMode === 'custom'
              ? `Playing with ${settings.customWordCount} custom words`
              : 'Playing with the built-in word list'}
          </p>
        )}
      </div>

      <div className="mt-auto flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="invite-link" className="text-sm font-extrabold">
            Invite your friends
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="invite-link"
              readOnly
              value={inviteUrl}
              className="field min-w-0 flex-1 text-sm blur-[3px] transition hover:blur-none focus:blur-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn btn-brand" onClick={() => void copyInvite()}>
              Copy
            </button>
          </div>
        </div>
        {isHost && (
          <button
            type="button"
            className="btn btn-play px-8 py-3 text-xl sm:text-2xl"
            disabled={!canStart || starting}
            onClick={() => void start()}
          >
            {canStart ? 'Start!' : `Need ${state.minPlayers} players (${online}/${state.minPlayers})`}
          </button>
        )}
      </div>
    </section>
  )
}
