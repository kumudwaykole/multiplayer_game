import { pino } from 'pino';
import type { AcceptedOperation, DrawOperation } from '../../src/drawing/operations.js';
import { RoomRuntime } from '../../src/game/room.js';
import { DEFAULT_SETTINGS, type RoomSettings } from '../../src/game/settings.js';
import { DrawingWriter } from '../../src/persistence/drawingWriter.js';
import {
  ServerEvents,
  type ChatEvent,
  type PublicRoomState,
  type SnapshotPayload,
  type StateEvent,
  type WordChoice,
} from '../../src/realtime/protocol.js';
import { FakeClock } from './fakeClock.js';
import { FakeTransport } from './fakeTransport.js';
import { MemoryRepository } from './memoryRepository.js';

export interface TestPlayer {
  name: string;
  sessionId: string;
  socketId: string;
  id: string;
}

const CODE = 'AAAAAAAAAAAAAAAA';
let socketCounter = 0;
let commandCounter = 0;

export function nextCommandId(): string {
  return `c${++commandCounter}`;
}

/** A RoomRuntime wired to an in-memory repository, fake clock and fake sockets. */
export class RoomHarness {
  readonly clock = new FakeClock();
  readonly transport = new FakeTransport();
  readonly repo: MemoryRepository;
  readonly writer: DrawingWriter;
  readonly room: RoomRuntime;
  readonly players = new Map<string, TestPlayer>();
  closed = false;

  constructor(options: { settings?: Partial<RoomSettings>; minPlayers?: number; graceMs?: number } = {}) {
    this.repo = new MemoryRepository(CODE, { ...DEFAULT_SETTINGS, ...options.settings });
    const logger = pino({ level: 'silent' });
    this.writer = new DrawingWriter(this.repo, { batchMs: 0, maxPending: 10_000 }, logger);
    this.room = new RoomRuntime(
      {
        id: this.repo.room.id,
        code: CODE,
        status: 'OPEN',
        hostMembershipId: null,
        settings: this.repo.room.settings,
        settingsVersion: 0,
        members: [],
      },
      {
        repo: this.repo,
        writer: this.writer,
        transport: this.transport,
        clock: this.clock,
        logger,
        config: {
          minPlayers: options.minPlayers ?? 3,
          graceMs: options.graceMs ?? 30_000,
          idleMs: 30 * 60_000,
          maxQueueDepth: 1000,
        },
        onClosed: () => {
          this.closed = true;
        },
      },
    );
  }

  /** Waits until the room queue and the drawing writer have no pending work. */
  settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await this.room.whenIdle();
      await this.writer.drain();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  async advance(ms: number): Promise<void> {
    await this.clock.advance(ms, this.settle);
  }

  async addPlayer(name: string): Promise<TestPlayer> {
    const sessionId = `session-${name}`;
    await this.room.join(sessionId, name);
    const socketId = `socket-${name}-${++socketCounter}`;
    const { playerId } = await this.room.subscribe(sessionId, socketId, {});
    const player = { name, sessionId, socketId, id: playerId };
    this.players.set(name, player);
    return player;
  }

  async reconnect(player: TestPlayer, request: { turnId?: string; canvasSeq?: number } = {}): Promise<TestPlayer> {
    const socketId = `socket-${player.name}-${++socketCounter}`;
    await this.room.subscribe(player.sessionId, socketId, request);
    player.socketId = socketId;
    return player;
  }

  async disconnect(player: TestPlayer): Promise<void> {
    this.transport.drop(player.socketId);
    await this.room.disconnect(player.id, player.socketId);
    await this.settle();
  }

  /** Latest public state as seen by this socket (snapshot or broadcast). */
  state(player: TestPlayer): PublicRoomState {
    const events = this.transport
      .received(player.socketId)
      .filter((r) => r.event === ServerEvents.state || r.event === ServerEvents.snapshot);
    const last = events.at(-1);
    if (!last) throw new Error(`${player.name} has no state yet`);
    return last.event === ServerEvents.snapshot
      ? (last.payload as SnapshotPayload).state
      : (last.payload as StateEvent).state;
  }

  chat(player: TestPlayer): ChatEvent[] {
    return this.transport.received(player.socketId, ServerEvents.chat).map((r) => r.payload as ChatEvent);
  }

  choices(player: TestPlayer): { turnId: string; choices: WordChoice[] } | undefined {
    return this.transport.last(player.socketId, ServerEvents.wordChoices);
  }

  async start(host: TestPlayer): Promise<void> {
    await this.room.startGame(host.id, host.socketId);
    await this.settle();
  }

  /** Has the current drawer pick a word; returns the chosen word and turn ID. */
  async chooseWord(drawer: TestPlayer, index = 0): Promise<{ word: string; turnId: string }> {
    const offer = this.choices(drawer);
    if (!offer) throw new Error(`${drawer.name} was not offered words`);
    const choice = offer.choices[index]!;
    await this.room.selectWord(drawer.id, drawer.socketId, offer.turnId, choice.id);
    await this.settle();
    return { word: choice.word, turnId: offer.turnId };
  }

  async say(player: TestPlayer, text: string, receivedMono = this.clock.now()) {
    const result = await this.room.chat(player.id, player.socketId, nextCommandId(), text, receivedMono);
    await this.settle();
    return result;
  }

  async draw(player: TestPlayer, turnId: string, op: DrawOperation, commandId = nextCommandId()) {
    const result = await this.room.draw(player.id, player.socketId, commandId, turnId, op, this.clock.now());
    await this.settle();
    return result;
  }

  drawn(player: TestPlayer): AcceptedOperation[] {
    return this.transport.received(player.socketId, ServerEvents.draw).map((r) => r.payload as AcceptedOperation);
  }

  playerByRole(role: 'drawer'): TestPlayer {
    const any = [...this.players.values()][0]!;
    const drawerId = this.state(any).turn?.drawerId;
    const drawer = [...this.players.values()].find((p) => p.id === drawerId);
    if (!drawer) throw new Error(`no ${role}`);
    return drawer;
  }
}
