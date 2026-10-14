import { io, type Socket } from 'socket.io-client'
import { CanvasSync } from '../drawing/canvasSync'
import type {
  Ack,
  AcceptedOperation,
  CanvasChunkPayload,
  ChatEvent,
  ChatMessage,
  DrawOperation,
  GuessStatus,
  PublicRoomState,
  RoomSettings,
  SnapshotPayload,
  StateEvent,
  WordChoice,
} from '../lib/protocol'
import { Store } from '../lib/store'
import { ServerClock } from './clock'

/** Chat lines only this player sees (near misses, notices). */
export type LocalLine = { id: string; at: number; kind: 'local'; tone: 'close' | 'info' | 'error' | 'draw' | 'success'; text: string }
export type ChatLine = ChatMessage | LocalLine

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'replaced' | 'left' | 'error'

export interface RoomView {
  status: ConnectionStatus
  error: string | null
  playerId: string | null
  state: PublicRoomState | null
  chat: ChatLine[]
  /** Only for the drawer: offered words, then the chosen one. */
  secret: { turnId: string; choices: WordChoice[] | null; word: string | null; deadline: number | null } | null
  /** Only for the host: full settings including custom words. */
  hostSettings: RoomSettings | null
  /** Bumped when this player guesses right (for the little celebration). */
  lastCorrectAt: number
  /** What this player typed when they guessed right, so they can see the word. */
  solved: { turnId: string; key: string } | null
}

const CHAT_LIMIT = 120
const ACK_TIMEOUT_MS = 6_000

/**
 * One room's live connection. Owns the socket, the public room state, the
 * chat log and the canvas sync, so React only renders state and never
 * touches drawing data.
 */
export class RoomConnection {
  readonly view = new Store<RoomView>({
    status: 'connecting',
    error: null,
    playerId: null,
    state: null,
    chat: [],
    secret: null,
    hostSettings: null,
    lastCorrectAt: 0,
    solved: null,
  })
  readonly clock = new ServerClock()
  readonly canvas = new CanvasSync()

  private readonly socket: Socket
  private lastEventSeq = 0
  private resyncing = false
  private localSeq = 0
  private commandSeq = 0
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  readonly code: string

  constructor(code: string) {
    this.code = code
    this.socket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 4_000,
      autoConnect: false,
    })
    this.canvas.onGap = () => this.resync()
    this.canvas.onReject = (ack) => {
      if (ack.code === 'RATE_LIMITED') this.pushLocal('error', 'Drawing too fast - slow down a little.')
      else if (ack.code === 'TURN_BUDGET_EXCEEDED') this.pushLocal('error', 'This drawing is full. Time to let them guess!')
    }
  }

  connect(): void {
    this.disposed = false
    if (!this.socket.hasListeners('connect')) this.bind()
    this.socket.connect()
  }

  /** Disconnects and unbinds. Safe to call connect() again afterwards. */
  dispose(): void {
    this.disposed = true
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    this.canvas.setTransport(null)
    this.socket.removeAllListeners()
    this.socket.disconnect()
  }

  // --------------------------------------------------------------- commands

  send(event: string, payload: Record<string, unknown> = {}): Promise<Ack> {
    const commandId = `c${(++this.commandSeq).toString(36)}${Date.now().toString(36)}`
    return this.socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck(event, { commandId, ...payload })
      .then((ack: Ack) => ack)
      .catch(() => ({ commandId, ok: false, code: 'TIMEOUT', message: 'The server did not answer in time' }))
  }

  startGame = () => this.send('game:start')
  returnToLobby = () => this.send('room:lobby')
  selectWord = (turnId: string, candidateId: string) => this.send('word:select', { turnId, candidateId })

  async leave(): Promise<void> {
    await this.send('room:leave')
    this.view.set((v) => ({ ...v, status: 'left' }))
    this.dispose()
  }

  async chat(text: string): Promise<Ack> {
    const ack = await this.send('chat:send', { text })
    if (!ack.ok && ack.code !== 'TIMEOUT') this.pushLocal('error', ack.message ?? 'Message not sent')
    if (ack.ok && ack.result) this.onGuessStatus(ack.result, text)
    const turnId = this.view.get().state?.turn?.id
    if (ack.ok && ack.result === 'correct' && turnId) {
      const key = text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '')
      this.view.set((v) => ({ ...v, solved: { turnId, key } }))
    }
    return ack
  }

  /** Host only: keep the full settings in sync after saving or reloading them. */
  setHostSettings(settings: RoomSettings): void {
    this.view.set((v) => ({ ...v, hostSettings: settings }))
  }

  /** Take control back after another tab replaced this one. */
  reclaim(): void {
    this.view.set((v) => ({ ...v, status: 'connecting' }))
    if (this.socket.connected) this.subscribe()
    else this.socket.connect()
  }

  // ----------------------------------------------------------------- events

  private bind(): void {
    const s = this.socket
    s.on('connect', () => {
      this.subscribe()
      this.startClockSync()
    })
    s.on('disconnect', (reason) => {
      if (this.disposed) return
      this.canvas.setTransport(null)
      const status = this.view.get().status
      if (status === 'replaced' || status === 'left') return
      // "io server disconnect" means the server dropped us on purpose; reconnect manually.
      if (reason === 'io server disconnect') s.connect()
      this.view.set((v) => ({ ...v, status: 'reconnecting' }))
    })
    s.on('connect_error', (err) => {
      if (err.message === 'UNAUTHENTICATED') {
        this.view.set((v) => ({ ...v, status: 'error', error: 'Your session expired. Reload the page to rejoin.' }))
        s.disconnect()
      } else if (this.view.get().status !== 'error') {
        this.view.set((v) => ({ ...v, status: 'reconnecting' }))
      }
    })

    s.on('room:snapshot', (snap: SnapshotPayload) => this.onSnapshot(snap))
    s.on('canvas:chunk', (chunk: CanvasChunkPayload) => this.canvas.addChunk(chunk.turnId, chunk.ops, chunk.last))
    s.on('room:state', (event: StateEvent) => {
      if (!this.checkSeq(event.eventSeq)) return
      this.applyState(event.state, event.reason)
    })
    s.on('chat:message', (event: ChatEvent) => {
      if (!this.checkSeq(event.eventSeq)) return
      this.appendChat(event.message)
    })
    s.on('draw:operation', (op: AcceptedOperation) => this.canvas.onRemote(op))
    s.on('word:choices', (e: { turnId: string; choices: WordChoice[]; deadline: number }) => {
      this.view.set((v) => ({ ...v, secret: { turnId: e.turnId, choices: e.choices, word: null, deadline: e.deadline } }))
    })
    s.on('word:selected', (e: { turnId: string; word: string }) => {
      this.view.set((v) => ({ ...v, secret: { turnId: e.turnId, choices: null, word: e.word, deadline: null } }))
    })
    s.on('guess:result', (e: { status: GuessStatus; text?: string }) => {
      if (e.status === 'close' && e.text) this.pushLocal('close', `'${e.text}' is close!`)
    })
    s.on('room:replaced', () => {
      this.canvas.setTransport(null)
      this.view.set((v) => ({ ...v, status: 'replaced' }))
    })
    s.on('server:draining', () => {
      this.canvas.setTransport(null)
      this.view.set((v) => ({ ...v, status: 'reconnecting' }))
    })
  }

  private subscribe(): void {
    const turnId = this.canvas.turnId
    void this.send('room:subscribe', {
      code: this.code,
      ...(turnId ? { turnId, canvasSeq: this.canvas.seq } : {}),
    }).then((ack) => {
      this.resyncing = false
      if (ack.ok) return
      if (ack.code === 'NOT_MEMBER' || ack.code === 'ROOM_NOT_FOUND' || ack.code === 'ROOM_CLOSED') {
        this.view.set((v) => ({ ...v, status: 'error', error: ack.message ?? 'You are no longer in this room.' }))
      } else if (ack.code !== 'TIMEOUT') {
        this.view.set((v) => ({ ...v, status: 'error', error: ack.message ?? 'Could not join the room.' }))
      }
    })
  }

  /** Something was missed: get an authoritative snapshot (and missing strokes). */
  private resync(): void {
    if (this.resyncing || !this.socket.connected) return
    this.resyncing = true
    this.subscribe()
  }

  private checkSeq(eventSeq: number): boolean {
    if (this.resyncing) return false
    if (eventSeq <= this.lastEventSeq) return false
    if (eventSeq !== this.lastEventSeq + 1) {
      this.resync()
      return false
    }
    this.lastEventSeq = eventSeq
    return true
  }

  private onSnapshot(snap: SnapshotPayload): void {
    this.lastEventSeq = snap.eventSeq
    this.resyncing = false
    this.clock.seed(snap.serverNow)
    const secret = snap.you.secret ? { ...snap.you.secret, deadline: snap.state.turn?.choosingDeadline ?? null } : null
    this.view.set((v) => ({
      ...v,
      status: 'live',
      error: null,
      playerId: snap.you.playerId,
      chat: mergeChat(v.chat, snap.chat),
      secret,
      hostSettings: snap.you.hostSettings,
    }))
    this.canvas.beginSnapshot(snap.canvas)
    this.applyState(snap.state, 'snapshot')
  }

  private applyState(state: PublicRoomState, reason: string): void {
    const view = this.view.get()
    const turn = state.turn
    // A new turn starts with a blank canvas.
    if (turn && turn.id !== this.canvas.turnId && turn.status !== 'ended') this.canvas.reset(turn.id)
    if (!turn && state.phase !== 'TURN_RESULT' && this.canvas.turnId !== null) this.canvas.reset(null)

    const amDrawer = !!turn && turn.status === 'drawing' && turn.drawerId === view.playerId
    this.canvas.setTransport(amDrawer ? { send: this.sendDraw } : null)

    let secret = view.secret
    if (secret && (!turn || turn.id !== secret.turnId || turn.status === 'ended')) secret = null
    const hostSettings = state.hostId === view.playerId ? view.hostSettings : null
    const youGuessed = reason === 'guess:correct' && !!view.playerId && state.turn?.guessedIds.at(-1) === view.playerId
    this.view.set((v) => ({
      ...v,
      state,
      secret,
      hostSettings,
      lastCorrectAt: youGuessed ? Date.now() : v.lastCorrectAt,
    }))
    if (reason === 'turn:started' && turn) {
      const drawer = state.players.find((p) => p.id === turn.drawerId)
      if (drawer) this.pushLocal('draw', `${drawer.name} is drawing now!`)
    } else if (reason === 'turn:ended' && state.turnResult?.answer) {
      this.pushLocal('success', `The word was '${state.turnResult.answer}'`)
    }
  }

  private sendDraw = (turnId: string, commandId: string, op: DrawOperation): Promise<Ack> =>
    this.socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck('draw:operation', { commandId, turnId, op })
      .then((ack: Ack) => ack)
      .catch(() => ({ commandId, ok: false, code: 'TIMEOUT' }))

  private onGuessStatus(status: GuessStatus, text: string): void {
    if (status === 'not_eligible') this.pushLocal('info', 'You joined mid-turn - you can guess from the next turn.')
    else if (status === 'late') this.pushLocal('info', `Too late! '${text}' arrived after time ran out.`)
  }

  private appendChat(message: ChatMessage): void {
    this.view.set((v) => ({ ...v, chat: [...v.chat, message].slice(-CHAT_LIMIT) }))
  }

  private pushLocal(tone: LocalLine['tone'], text: string): void {
    const line: LocalLine = { id: `local-${++this.localSeq}`, at: Date.now(), kind: 'local', tone, text }
    this.view.set((v) => ({ ...v, chat: [...v.chat, line].slice(-CHAT_LIMIT) }))
  }

  /** A few quick samples, then one every 15 s. */
  private startClockSync(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    let burst = 4
    const ping = () => {
      const t0 = Date.now()
      void this.send('time:sync').then((ack) => {
        if (ack.ok && typeof ack.serverNow === 'number') this.clock.addSample(t0, Date.now(), ack.serverNow)
      })
    }
    ping()
    this.syncTimer = setInterval(() => {
      ping()
      if (burst > 0 && --burst === 0 && this.syncTimer) {
        clearInterval(this.syncTimer)
        this.syncTimer = setInterval(ping, 15_000)
      }
    }, 1_500)
  }
}

/** Keeps our local lines when a snapshot replaces the server chat log. */
function mergeChat(current: ChatLine[], server: ChatMessage[]): ChatLine[] {
  const locals = current.filter((line): line is LocalLine => line.kind === 'local')
  return [...server, ...locals].sort((a, b) => a.at - b.at).slice(-CHAT_LIMIT)
}
