/**
 * Socket.IO load harness: real `socket.io-client` connections playing real games.
 *
 *   pnpm --filter server load -- --rooms 25 --players 8 --duration 300 --warmup 60
 *
 * The target server must allow many sessions from one IP and expose metrics:
 *   IP_RATE_LIMIT_SCALE=100000 METRICS_TOKEN=<16+ chars> pnpm --filter server dev
 *
 * Per room: one host creates the room, the others join, the host starts a game.
 * The drawer streams `stroke.points` batches (default 30/s, 8 points each) with
 * a stroke every 2 s, a fill every 10 s and an undo now and then. Guessers send
 * wrong guesses, then the right one at a random point (the harness shares the
 * word in-process, standing in for players who recognise the drawing). Once a
 * minute one guesser per room drops and reconnects.
 *
 * Latency is measured on this process's clock: from the drawer's send to the
 * ack, and to each receiver getting the broadcast. This includes network and
 * persistence but not browser rendering. Canvas sequences are checked for
 * gaps and duplicates on every receiver.
 */
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { io, type Socket } from 'socket.io-client';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:3000' },
    origin: { type: 'string', default: 'http://localhost:5173' },
    rooms: { type: 'string', default: '10' },
    players: { type: 'string', default: '8' },
    duration: { type: 'string', default: '300' },
    warmup: { type: 'string', default: '60' },
    'batches-per-sec': { type: 'string', default: '30' },
    'points-per-batch': { type: 'string', default: '8' },
    'draw-time': { type: 'string', default: '80' },
    'metrics-token': { type: 'string', default: process.env.METRICS_TOKEN ?? '' },
    out: { type: 'string' },
  },
});

const URL_BASE = args.url!;
const ORIGIN = args.origin!;
const ROOMS = Number(args.rooms);
const PLAYERS = Number(args.players);
const DURATION_S = Number(args.duration);
const WARMUP_S = Number(args.warmup);
const BATCHES_PER_SEC = Number(args['batches-per-sec']);
const POINTS_PER_BATCH = Number(args['points-per-batch']);
const DRAW_TIME_S = Number(args['draw-time']);

// ------------------------------------------------------------------ stats

class Samples {
  private values: number[] = [];
  add(v: number) {
    this.values.push(v);
  }
  report() {
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);
    return {
      count: sorted.length,
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(sorted.at(-1) ?? 0),
    };
  }
  reset() {
    this.values = [];
  }
}

const round = (v: number) => Math.round(v * 10) / 10;

const stats = {
  measuring: false,
  ackMs: new Samples(),
  broadcastMs: new Samples(),
  snapshotMs: new Samples(),
  opsSent: 0,
  opsReceived: 0,
  guesses: 0,
  correctGuesses: 0,
  turnsEnded: 0,
  reconnects: 0,
  reconnectFailures: 0,
  sequenceGaps: 0,
  sequenceDuplicates: 0,
  errors: new Map<string, number>(),
};

function countError(code: string) {
  if (!stats.measuring) return;
  stats.errors.set(code, (stats.errors.get(code) ?? 0) + 1);
}

// ----------------------------------------------------------------- client

let commandSeq = 0;
const nextCommand = () => `l${(++commandSeq).toString(36)}`;

class Player {
  readonly cookies = new Map<string, string>();
  socket: Socket | null = null;
  /** Highest canvas sequence seen for the current turn. */
  canvasTurn: string | null = null;
  canvasSeq = 0;

  constructor(
    readonly room: RoomSim,
    readonly name: string,
  ) {}

  private get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async http(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: this.cookieHeader,
        'x-csrf-token': this.cookies.get('dg_csrf') ?? '',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  async signIn() {
    await this.http('GET', '/api/session');
    await this.http('POST', '/api/session', { displayName: this.name });
  }

  async connect(): Promise<void> {
    const socket = io(URL_BASE, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { origin: ORIGIN, cookie: this.cookieHeader },
    });
    this.socket = socket;
    socket.on('draw:operation', (op: { turnId: string; canvasSeq: number; commandId: string }) => this.onDraw(op));
    socket.on('room:state', (e: { reason: string; state: any }) => this.room.onState(this, e));
    socket.on('word:choices', (e: { turnId: string; choices: Array<{ id: string }> }) => this.room.onChoices(this, e));
    socket.on('word:selected', (e: { turnId: string; word: string }) => this.room.onWord(this, e));
    socket.on('canvas:chunk', (e: { turnId: string; ops: Array<{ canvasSeq: number }> }) => {
      for (const op of e.ops) this.trackSeq(e.turnId, op.canvasSeq);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  }

  async subscribe(): Promise<void> {
    const started = performance.now();
    const snapshot = new Promise<{ canvas: { turnId: string | null; throughSeq: number; chunkCount: number } }>((resolve) =>
      this.socket!.once('room:snapshot', resolve),
    );
    const ack = await this.send('room:subscribe', { code: this.room.code });
    if (!ack.ok) throw new Error(`subscribe failed: ${ack.code}`);
    const snap = await snapshot;
    this.canvasTurn = snap.canvas.turnId;
    this.canvasSeq = snap.canvas.chunkCount === 0 ? snap.canvas.throughSeq : 0;
    if (stats.measuring) stats.snapshotMs.add(performance.now() - started);
  }

  send(event: string, payload: Record<string, unknown> = {}): Promise<any> {
    const commandId = typeof payload.commandId === 'string' ? payload.commandId : nextCommand();
    return this.socket!.timeout(10_000)
      .emitWithAck(event, { commandId, ...payload })
      .then((ack: any) => {
        if (!ack.ok) countError(ack.code ?? 'UNKNOWN');
        return ack;
      })
      .catch(() => {
        countError('ACK_TIMEOUT');
        return { ok: false, code: 'ACK_TIMEOUT' };
      });
  }

  private onDraw(op: { turnId: string; canvasSeq: number; commandId: string }) {
    this.trackSeq(op.turnId, op.canvasSeq);
    const sentAt = this.room.sentAt.get(op.commandId);
    if (sentAt !== undefined && this !== this.room.drawer && stats.measuring) {
      stats.broadcastMs.add(performance.now() - sentAt);
      stats.opsReceived++;
    }
  }

  private trackSeq(turnId: string, seq: number) {
    if (turnId !== this.canvasTurn) {
      this.canvasTurn = turnId;
      this.canvasSeq = 0;
    }
    if (seq <= this.canvasSeq) {
      if (stats.measuring) stats.sequenceDuplicates++;
    } else if (seq !== this.canvasSeq + 1) {
      if (stats.measuring) stats.sequenceGaps++;
      this.canvasSeq = seq;
    } else {
      this.canvasSeq = seq;
    }
  }

  close() {
    this.socket?.disconnect();
  }
}

// ------------------------------------------------------------------- room

class RoomSim {
  code = '';
  readonly players: Player[] = [];
  drawer: Player | null = null;
  word: string | null = null;
  turnId: string | null = null;
  readonly sentAt = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private strokeCounter = 0;
  private lastAction: string | null = null;

  constructor(readonly index: number) {
    for (let i = 0; i < PLAYERS; i++) this.players.push(new Player(this, `r${index}p${i}`));
  }

  async setup() {
    await Promise.all(this.players.map((p) => p.signIn()));
    const host = this.players[0]!;
    const created = await host.http('POST', '/api/rooms');
    this.code = created.code;
    for (const p of this.players.slice(1)) await p.http('POST', `/api/rooms/${this.code}/join`);
    const current = await host.http('GET', `/api/rooms/${this.code}/settings`);
    await host.http('PUT', `/api/rooms/${this.code}/settings`, {
      version: current.version,
      settings: { ...current.settings, rounds: 10, drawTimeSec: DRAW_TIME_S, maxPlayers: Math.max(3, PLAYERS) },
    });
    for (const p of this.players) {
      await p.connect();
      await p.subscribe();
    }
    const ack = await host.send('game:start');
    if (!ack.ok) throw new Error(`start failed: ${ack.code}`);
    this.every(60_000, () => void this.reconnectSomeone());
  }

  onChoices(player: Player, e: { turnId: string; choices: Array<{ id: string }> }) {
    setTimeout(() => void player.send('word:select', { turnId: e.turnId, candidateId: e.choices[0]!.id }), 500);
  }

  onWord(player: Player, e: { turnId: string; word: string }) {
    this.drawer = player;
    this.word = e.word;
    this.turnId = e.turnId;
    this.lastAction = null;
    void this.drawLoop(e.turnId);
    this.scheduleGuesses(e.turnId);
  }

  onState(player: Player, e: { reason: string; state: any }) {
    if (player !== this.players[0]) return;
    if (e.reason === 'turn:ended' && stats.measuring) stats.turnsEnded++;
    if (e.reason === 'turn:ended' || e.reason === 'game:ended' || e.reason === 'game:interrupted') this.turnId = null;
    if (e.reason === 'game:ended' || e.reason === 'game:interrupted') {
      setTimeout(() => void this.restartGame(), 2_000);
    }
  }

  private async restartGame() {
    if (this.stopped) return;
    // The host never takes part in the reconnect churn, so it stays host.
    const host = this.players[0]!;
    await host.send('room:lobby');
    await host.send('game:start');
  }

  private async drawLoop(turnId: string) {
    const drawer = this.drawer!;
    const interval = 1000 / BATCHES_PER_SEC;
    let strokeId: string | null = null;
    let strokeStarted = 0;
    let x = 500;
    let y = 350;
    let lastFill = performance.now();
    while (!this.stopped && this.turnId === turnId && drawer.socket?.connected) {
      const now = performance.now();
      if (!strokeId) {
        strokeId = `s${++this.strokeCounter}`;
        strokeStarted = now;
        await this.sendOp(drawer, turnId, {
          type: 'stroke.begin',
          strokeId,
          tool: 'pen',
          color: '#1e90ff',
          width: 6,
          point: [x, y],
        });
      } else if (now - strokeStarted > 2_000) {
        const ack = await this.sendOp(drawer, turnId, { type: 'stroke.end', strokeId });
        if (ack.ok) this.lastAction = ack.actionId;
        strokeId = null;
        if (now - lastFill > 10_000) {
          lastFill = now;
          const fill = await this.sendOp(drawer, turnId, { type: 'fill', point: [x, y], color: '#ffd700' });
          if (fill.ok) this.lastAction = fill.actionId;
        } else if (this.lastAction && Math.random() < 0.1) {
          const undo = await this.sendOp(drawer, turnId, { type: 'undo', targetActionId: this.lastAction });
          if (undo.ok) this.lastAction = null;
        }
      } else {
        const points: Array<[number, number]> = [];
        for (let i = 0; i < POINTS_PER_BATCH; i++) {
          x = Math.min(999, Math.max(0, x + (Math.random() - 0.5) * 20));
          y = Math.min(699, Math.max(0, y + (Math.random() - 0.5) * 20));
          points.push([Math.round(x), Math.round(y)]);
        }
        void this.sendOp(drawer, turnId, { type: 'stroke.points', strokeId, points });
      }
      await sleep(interval);
    }
  }

  private async sendOp(drawer: Player, turnId: string, op: Record<string, unknown>) {
    const commandId = nextCommand();
    const sent = performance.now();
    this.sentAt.set(commandId, sent);
    if (this.sentAt.size > 5_000) this.sentAt.delete(this.sentAt.keys().next().value!);
    if (stats.measuring) stats.opsSent++;
    const ack = await drawer.send('draw:operation', { commandId, turnId, op });
    if (ack.ok && stats.measuring) stats.ackMs.add(performance.now() - sent);
    return ack;
  }

  private scheduleGuesses(turnId: string) {
    const guessers = this.players.filter((p) => p !== this.drawer);
    for (const guesser of guessers) {
      const wrongEvery = 4_000 + Math.random() * 4_000;
      const correctAt = DRAW_TIME_S * 1000 * (0.2 + Math.random() * 0.7);
      const started = performance.now();
      const tick = async () => {
        if (this.stopped || this.turnId !== turnId) return;
        if (performance.now() - started >= correctAt) {
          const ack = await guesser.send('chat:send', { text: this.word! });
          if (stats.measuring) {
            stats.guesses++;
            if (ack.result === 'correct') stats.correctGuesses++;
          }
          return;
        }
        await guesser.send('chat:send', { text: `guess ${Math.random().toString(36).slice(2, 7)}` });
        if (stats.measuring) stats.guesses++;
        setTimeout(() => void tick(), wrongEvery);
      };
      setTimeout(() => void tick(), wrongEvery);
    }
  }

  private async reconnectSomeone() {
    const candidates = this.players.filter((p) => p !== this.drawer && p !== this.players[0]);
    const player = candidates[Math.floor(Math.random() * candidates.length)];
    if (!player) return;
    player.close();
    await sleep(2_000);
    try {
      await player.http('POST', `/api/rooms/${this.code}/join`);
      await player.connect();
      await player.subscribe();
      if (stats.measuring) stats.reconnects++;
    } catch {
      if (stats.measuring) stats.reconnectFailures++;
    }
  }

  private every(ms: number, fn: () => void) {
    this.timers.push(setInterval(fn, ms));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const p of this.players) p.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function serverMetrics(): Promise<unknown> {
  if (!args['metrics-token']) return null;
  const res = await fetch(`${URL_BASE}/api/metrics`, { headers: { authorization: `Bearer ${args['metrics-token']}` } });
  return res.ok ? res.json() : { error: res.status };
}

async function main() {
  console.log(`setting up ${ROOMS} rooms x ${PLAYERS} players against ${URL_BASE}`);
  const rooms = Array.from({ length: ROOMS }, (_, i) => new RoomSim(i));
  // Set rooms up in small groups so setup itself is not the bottleneck.
  for (let i = 0; i < rooms.length; i += 5) {
    await Promise.all(rooms.slice(i, i + 5).map((room) => room.setup()));
  }
  console.log(`warming up for ${WARMUP_S}s`);
  await sleep(WARMUP_S * 1000);
  await serverMetrics(); // resets the server's event-loop histogram
  stats.measuring = true;
  const startedAt = new Date().toISOString();
  console.log(`measuring for ${DURATION_S}s`);
  await sleep(DURATION_S * 1000);
  stats.measuring = false;
  const server = await serverMetrics();
  for (const room of rooms) room.stop();

  const report = {
    startedAt,
    workload: {
      rooms: ROOMS,
      playersPerRoom: PLAYERS,
      batchesPerSec: BATCHES_PER_SEC,
      pointsPerBatch: POINTS_PER_BATCH,
      drawTimeSec: DRAW_TIME_S,
      warmupSec: WARMUP_S,
      durationSec: DURATION_S,
    },
    client: {
      drawAckMs: stats.ackMs.report(),
      broadcastMs: stats.broadcastMs.report(),
      snapshotOnReconnectMs: stats.snapshotMs.report(),
      opsSentPerSec: round(stats.opsSent / DURATION_S),
      opsReceivedPerSec: round(stats.opsReceived / DURATION_S),
      guesses: stats.guesses,
      correctGuesses: stats.correctGuesses,
      turnsEnded: stats.turnsEnded,
      reconnects: stats.reconnects,
      reconnectFailures: stats.reconnectFailures,
      sequenceGaps: stats.sequenceGaps,
      sequenceDuplicates: stats.sequenceDuplicates,
      errors: Object.fromEntries(stats.errors),
    },
    server,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.out) await writeFile(args.out, JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
