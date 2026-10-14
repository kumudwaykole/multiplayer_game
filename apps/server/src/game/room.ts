import { randomInt, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { TurnCanvas, type AcceptedOperation, type DrawOperation } from '../drawing/operations.js';
import type { Clock, TimerHandle } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { randomToken } from '../lib/ids.js';
import { SerialQueue } from '../lib/serialQueue.js';
import type { Metrics } from '../observability/metrics.js';
import type { DrawingSink } from '../persistence/drawingWriter.js';
import {
  ServerEvents,
  type CanvasChunkPayload,
  type ChatMessage,
  type Avatar,
  type GameResult,
  type GuessStatus,
  type Phase,
  type PublicPlayer,
  type PublicRoomState,
  type PublicTurn,
  type SnapshotPayload,
  type TurnEndReason,
  type TurnResult,
  type WordChoice,
} from '../realtime/protocol.js';
import type { RoomTransport } from '../realtime/transport.js';
import { buildMask, chooseHintPositions, hintSchedule } from './hints.js';
import type { GameRepository, LoadedRoom } from './repository.js';
import { drawerPoints, guesserPoints, rankPlayers } from './scoring.js';
import {
  CHOOSE_TIME_MS,
  INTERMISSION_MS,
  freezeSettings,
  publicSettings,
  wordPool,
  type FrozenGameSettings,
  type RoomSettings,
} from './settings.js';
import { guessKey, isCloseGuess } from './text.js';
import { pickWords } from './words.js';

export interface RoomConfig {
  minPlayers: number;
  graceMs: number;
  idleMs: number;
  maxQueueDepth: number;
}

export interface RoomDeps {
  repo: GameRepository;
  writer: DrawingSink;
  transport: RoomTransport;
  clock: Clock;
  logger: Logger;
  metrics?: Metrics;
  config: RoomConfig;
  onClosed: (room: RoomRuntime) => void;
}

type Presence = 'online' | 'grace' | 'offline';

interface Member {
  id: string;
  sessionId: string;
  name: string;
  avatar: Avatar;
  joinedAt: number;
  status: 'active' | 'left';
  presence: Presence;
  /** The one socket allowed to act for this member. */
  socketId: string | null;
  /** Bumped on every connect and disconnect, so stale timers and callbacks are ignored. */
  gen: number;
  graceTimer: TimerHandle | null;
  recentCommands: Map<string, ChatOutcome>;
}

interface GamePlayerState {
  gamePlayerId: string;
  membershipId: string;
  name: string;
  avatar: Avatar;
  score: number;
}

interface GameState {
  id: string;
  settings: FrozenGameSettings;
  pool: readonly string[];
  usedWords: Set<string>;
  round: number;
  roster: string[];
  rosterIndex: number;
  turnCounter: number;
  players: Map<string, GamePlayerState>;
  nextRosterPosition: number;
}

interface TurnState {
  id: string;
  drawerId: string;
  drawerGamePlayerId: string;
  round: number;
  status: 'choosing' | 'drawing' | 'ended';
  candidates: WordChoice[];
  choosingDeadline: number;
  answer: string | null;
  answerKey: string;
  hintPositions: number[];
  revealed: Set<number>;
  startMono: number;
  durationMs: number;
  deadlineMono: number;
  deadlineWall: number;
  /** Fixed when drawing starts. */
  eligible: Set<string>;
  /** Eligible guessers who have not guessed and have not gone. */
  pending: Set<string>;
  /** Correct guessers and the points each earned. */
  correct: Map<string, number>;
  canvas: TurnCanvas;
  drawAcks: Map<string, Promise<DrawResult>>;
  lastCommit: Promise<void>;
  timers: TimerHandle[];
}

export interface DrawResult {
  canvasSeq: number;
  actionId: string;
}

export interface ChatOutcome {
  result?: GuessStatus;
}

export interface SubscribeRequest {
  turnId?: string | undefined;
  canvasSeq?: number | undefined;
}

const CHAT_LOG_SIZE = 50;
const RECENT_COMMANDS = 64;
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;

/**
 * The authoritative state of one room. Every mutation, including timer
 * expiry and disconnects, runs through one serial queue, and each handler
 * re-checks the phase and turn ID before acting.
 */
export class RoomRuntime {
  readonly id: string;
  readonly code: string;
  readonly channel: string;

  private phase: Phase = 'LOBBY';
  private hostId: string | null;
  private settings: RoomSettings;
  private settingsVersion: number;
  private readonly members = new Map<string, Member>();
  private game: GameState | null = null;
  private turn: TurnState | null = null;
  private turnResult: TurnResult | null = null;
  private gameResult: GameResult | null = null;
  private eventSeq = 0;
  private chatSeq = 0;
  private readonly chatLog: ChatMessage[] = [];
  private readonly queue: SerialQueue;
  private idleTimer: TimerHandle | null = null;
  private intermissionTimer: TimerHandle | null = null;
  private closed = false;

  constructor(
    loaded: LoadedRoom,
    private readonly deps: RoomDeps,
  ) {
    this.id = loaded.id;
    this.code = loaded.code;
    this.channel = `room:${loaded.id}`;
    this.hostId = loaded.hostMembershipId;
    this.settings = loaded.settings;
    this.settingsVersion = loaded.settingsVersion;
    this.queue = new SerialQueue(deps.config.maxQueueDepth);

    const wall = deps.clock.wallNow();
    for (const stored of loaded.members) {
      const member: Member = {
        id: stored.id,
        sessionId: stored.sessionId,
        name: stored.displayName,
        avatar: stored.avatar,
        joinedAt: stored.joinedAt.getTime(),
        status: stored.status === 'ACTIVE' ? 'active' : 'left',
        presence: 'offline',
        socketId: null,
        gen: 0,
        graceTimer: null,
        recentCommands: new Map(),
      };
      this.members.set(member.id, member);
      // After a restart, members whose persisted recovery window is still
      // open keep their place until it runs out.
      const expiresAt = stored.recoveryExpiresAt?.getTime() ?? 0;
      if (member.status === 'active' && expiresAt > wall) {
        member.presence = 'grace';
        this.armGraceTimer(member, expiresAt - wall);
      }
    }
    if (!this.anyonePresent()) this.scheduleIdle();
  }

  // ---------------------------------------------------------------- queries

  get isClosed(): boolean {
    return this.closed;
  }

  get queueDepth(): number {
    return this.queue.size;
  }

  findMemberBySession(sessionId: string): { id: string; isHost: boolean } | null {
    const member = this.memberBySession(sessionId);
    if (!member || member.status !== 'active') return null;
    return { id: member.id, isHost: member.id === this.hostId };
  }

  /** Public summary for a member (HTTP). Null when the session is not a member. */
  summaryFor(sessionId: string): { playerId: string; state: PublicRoomState } | null {
    const member = this.memberBySession(sessionId);
    if (!member || member.status !== 'active') return null;
    return { playerId: member.id, state: this.buildState() };
  }

  hostSettingsFor(sessionId: string): { version: number; settings: RoomSettings } {
    const member = this.memberBySession(sessionId);
    if (!member || member.status !== 'active') throw new AppError('NOT_MEMBER', 'Join the room first');
    if (member.id !== this.hostId) throw new AppError('NOT_HOST', 'Only the host can view settings');
    return { version: this.settingsVersion, settings: this.settings };
  }

  onlineMemberIds(): string[] {
    return [...this.members.values()].filter((m) => m.presence === 'online').map((m) => m.id);
  }

  whenIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  // --------------------------------------------------------------- commands

  /** HTTP join: creates or restores membership. The member is "connecting" until a socket subscribes. */
  join(sessionId: string, displayName: string, avatar: Avatar = [0, 0, 0]): Promise<{ playerId: string }> {
    return this.queue.run(async () => {
      this.assertOpen();
      let member = this.memberBySession(sessionId);
      if (member && member.status === 'active' && member.presence !== 'offline') {
        const changed = member.name !== displayName || member.avatar.join() !== avatar.join();
        member.name = displayName;
        member.avatar = avatar;
        if (changed) this.broadcastState('player:updated');
        return { playerId: member.id };
      }
      if (this.presentMembers().length >= this.settings.maxPlayers) {
        throw new AppError('ROOM_FULL', 'This room is full');
      }
      const record = await this.deps.repo.upsertMembership(this.id, sessionId);
      if (!member) {
        member = {
          id: record.id,
          sessionId,
          name: displayName,
          avatar,
          joinedAt: record.joinedAt.getTime(),
          status: 'active',
          presence: 'offline',
          socketId: null,
          gen: 0,
          graceTimer: null,
          recentCommands: new Map(),
        };
        this.members.set(member.id, member);
      }
      member.status = 'active';
      member.name = displayName;
      member.avatar = avatar;
      await this.enterGrace(member);
      this.cancelIdle();
      await this.ensureHost();
      this.pushSystem('joined', member);
      this.broadcastState('player:joined');
      return { playerId: member.id };
    });
  }

  /** Socket subscription: takes control for this member and sends a snapshot. */
  subscribe(sessionId: string, socketId: string, request: SubscribeRequest): Promise<{ playerId: string }> {
    return this.queue.run(async () => {
      this.assertOpen();
      const member = this.memberBySession(sessionId);
      if (!member || member.status !== 'active' || member.presence === 'offline') {
        throw new AppError('NOT_MEMBER', 'Join the room first');
      }
      const previous = member.socketId;
      if (previous && previous !== socketId) {
        this.deps.transport.emitToSocket(previous, ServerEvents.replaced, {});
        this.deps.transport.leaveChannel(previous, this.channel);
      }
      const wasOnline = member.presence === 'online';
      this.deps.clock.clearTimeout(member.graceTimer);
      member.graceTimer = null;
      member.gen++;
      member.socketId = socketId;
      member.presence = 'online';
      await this.deps.repo.setRecoveryExpiry(
        [member.id],
        new Date(this.deps.clock.wallNow() + this.deps.config.graceMs),
      );
      if (this.game && !this.game.players.has(member.id)) await this.addGamePlayer(this.game, member);
      this.cancelIdle();
      const hostChanged = await this.ensureHost();
      await this.settleDrawing();
      this.sendSnapshot(member, socketId, request);
      this.deps.transport.joinChannel(socketId, this.channel);
      if (!wasOnline || hostChanged) this.broadcastState('player:connected');
      return { playerId: member.id };
    });
  }

  /** Socket closed. Ignored unless it is the member's controlling socket. */
  disconnect(memberId: string, socketId: string): Promise<void> {
    return this.queue.run(async () => {
      const member = this.members.get(memberId);
      if (!member || member.socketId !== socketId) return;
      member.socketId = null;
      if (member.status !== 'active' || this.closed) return;
      await this.enterGrace(member);
      if (this.isActiveDrawer(member.id)) await this.endTurn('DRAWER_DISCONNECTED');
      this.broadcastState('player:disconnected');
    });
  }

  leave(memberId: string, socketId: string): Promise<void> {
    return this.queue.run(async () => {
      const member = this.requireController(memberId, socketId);
      member.status = 'left';
      member.presence = 'offline';
      member.gen++;
      this.deps.clock.clearTimeout(member.graceTimer);
      member.graceTimer = null;
      member.socketId = null;
      this.deps.transport.leaveChannel(socketId, this.channel);
      await this.deps.repo.setMembershipStatus(member.id, 'LEFT', null);
      await this.memberGone(member, 'left');
    });
  }

  updateSettings(
    sessionId: string,
    expectedVersion: number,
    settings: RoomSettings,
  ): Promise<{ version: number; settings: RoomSettings }> {
    return this.queue.run(async () => {
      this.assertOpen();
      const member = this.memberBySession(sessionId);
      if (!member || member.status !== 'active') throw new AppError('NOT_MEMBER', 'Join the room first');
      if (member.id !== this.hostId) throw new AppError('NOT_HOST', 'Only the host can change settings');
      if (this.game) throw new AppError('WRONG_PHASE', 'Settings can only change between games');
      if (expectedVersion !== this.settingsVersion) {
        throw new AppError('SETTINGS_CONFLICT', 'Settings changed in the meantime; reload them');
      }
      const version = await this.deps.repo.saveSettings(this.id, settings, expectedVersion);
      if (version === null) throw new AppError('SETTINGS_CONFLICT', 'Settings changed in the meantime; reload them');
      this.settings = settings;
      this.settingsVersion = version;
      this.broadcastState('settings:changed');
      return { version, settings };
    });
  }

  startGame(memberId: string, socketId: string): Promise<void> {
    return this.queue.run(async () => {
      this.assertOpen();
      const member = this.requireController(memberId, socketId);
      if (member.id !== this.hostId) throw new AppError('NOT_HOST', 'Only the host can start the game');
      if (this.game) throw new AppError('WRONG_PHASE', 'A game is already running');
      const online = this.presentMembers()
        .filter((m) => m.presence === 'online')
        .sort(byJoinOrder);
      if (online.length < this.deps.config.minPlayers) {
        throw new AppError(
          'NOT_ENOUGH_PLAYERS',
          `At least ${this.deps.config.minPlayers} connected players are needed to start`,
        );
      }
      const settings = freezeSettings(this.settings);
      const created = await this.deps.repo.createGame({
        roomId: this.id,
        settings,
        players: online.map((m, index) => ({ membershipId: m.id, displayName: m.name, rosterPosition: index })),
      });
      const players = new Map<string, GamePlayerState>();
      for (const p of created.players) {
        const m = this.members.get(p.membershipId)!;
        players.set(m.id, { gamePlayerId: p.gamePlayerId, membershipId: m.id, name: m.name, avatar: m.avatar, score: 0 });
      }
      this.game = {
        id: created.gameId,
        settings,
        pool: wordPool(settings),
        usedWords: new Set(),
        round: 0,
        roster: [],
        rosterIndex: 0,
        turnCounter: 0,
        players,
        nextRosterPosition: online.length,
      };
      this.turn = null;
      this.turnResult = null;
      this.gameResult = null;
      this.deps.metrics?.inc('games_started');
      this.pushSystem('game_started', null);
      await this.nextTurn();
    });
  }

  returnToLobby(memberId: string, socketId: string): Promise<void> {
    return this.queue.run(() => {
      const member = this.requireController(memberId, socketId);
      if (member.id !== this.hostId) throw new AppError('NOT_HOST', 'Only the host can do that');
      if (this.phase !== 'GAME_RESULT') throw new AppError('WRONG_PHASE', 'The game is not over');
      this.phase = 'LOBBY';
      this.broadcastState('room:lobby');
    });
  }

  selectWord(memberId: string, socketId: string, turnId: string, candidateId: string): Promise<void> {
    return this.queue.run(async () => {
      const member = this.requireController(memberId, socketId);
      const turn = this.turn;
      if (!turn || turn.id !== turnId) throw new AppError('STALE_TURN', 'That turn is over');
      if (turn.status !== 'choosing') throw new AppError('WRONG_PHASE', 'The word was already chosen');
      if (turn.drawerId !== member.id) throw new AppError('NOT_DRAWER', 'Only the drawer can choose');
      const choice = turn.candidates.find((c) => c.id === candidateId);
      if (!choice) throw new AppError('BAD_REQUEST', 'Unknown word choice');
      await this.startDrawing(turn, choice);
    });
  }

  /**
   * Accepts one drawing operation. Resolves after it is durable and
   * broadcast; the sequence number and action ID are server-assigned.
   */
  draw(
    memberId: string,
    socketId: string,
    commandId: string,
    turnId: string,
    op: DrawOperation,
    receivedMono: number,
  ): Promise<DrawResult> {
    return this.queue
      .run(() => {
        const member = this.requireController(memberId, socketId);
        const turn = this.turn;
        if (!turn || turn.id !== turnId) throw new AppError('STALE_TURN', 'That turn is over');
        if (turn.status !== 'drawing') throw new AppError('WRONG_PHASE', 'Not drawing right now');
        if (turn.drawerId !== member.id) throw new AppError('NOT_DRAWER', 'Only the drawer can draw');
        const existing = turn.drawAcks.get(commandId);
        if (existing) return { wait: existing };
        if (turn.canvas.failed) throw new AppError('UNAVAILABLE', 'Drawing is recovering, retry shortly', 250);
        if (receivedMono >= turn.deadlineMono && op.type !== 'stroke.end') {
          throw new AppError('TURN_CLOSED', 'Time is up');
        }
        const accepted = turn.canvas.apply(commandId, op, receivedMono - turn.startMono);
        const wait = this.deps.writer.enqueue(accepted).then(
          () => {
            turn.canvas.markCommitted(accepted.canvasSeq);
            this.deps.transport.broadcast(this.channel, ServerEvents.draw, accepted);
            this.deps.metrics?.inc('drawing_ops_broadcast');
            return { canvasSeq: accepted.canvasSeq, actionId: accepted.actionId };
          },
          (err: unknown) => {
            this.onDrawFailure(turn, err);
            throw new AppError('UNAVAILABLE', 'Drawing could not be saved, retry', 250);
          },
        );
        turn.drawAcks.set(commandId, wait);
        turn.lastCommit = wait.then(
          () => undefined,
          () => undefined,
        );
        return { wait };
      })
      .then((r) => r.wait);
  }

  /** Chat and guesses share one input, as in the game: the server decides which it is. */
  chat(memberId: string, socketId: string, commandId: string, text: string, receivedMono: number): Promise<ChatOutcome> {
    return this.queue.run(async () => {
      const member = this.requireController(memberId, socketId);
      const cached = member.recentCommands.get(commandId);
      if (cached) return cached;
      const outcome = await this.handleChat(member, text, receivedMono);
      member.recentCommands.set(commandId, outcome);
      if (member.recentCommands.size > RECENT_COMMANDS) {
        member.recentCommands.delete(member.recentCommands.keys().next().value!);
      }
      return outcome;
    });
  }

  /** Planned shutdown: close any active turn and interrupt the game. */
  shutdown(): Promise<void> {
    return this.queue.run(async () => {
      if (this.turn && this.turn.status !== 'ended') await this.endTurn('SERVER_RESTART');
      if (this.game) await this.interruptGame();
      const online = this.onlineMemberIds();
      await this.deps.repo
        .setRecoveryExpiry(online, new Date(this.deps.clock.wallNow() + this.deps.config.graceMs))
        .catch((err: unknown) => this.deps.logger.warn({ err, room: this.code }, 'could not persist recovery'));
      this.clearAllTimers();
    });
  }

  /** Drops all in-memory state without persisting anything (process is going away). */
  dispose(): void {
    this.closed = true;
    this.clearAllTimers();
  }

  // ------------------------------------------------------------ game flow

  private async nextTurn(): Promise<void> {
    const game = this.game;
    if (!game) return;
    this.deps.clock.clearTimeout(this.intermissionTimer);
    this.intermissionTimer = null;
    if (this.presentGamePlayers().length < 2) {
      await this.interruptGame();
      return;
    }
    // Bounded loop: at most one pass over a new round's roster per round.
    for (let guard = 0; guard <= (game.settings.rounds + 1) * 16; guard++) {
      if (game.rosterIndex >= game.roster.length) {
        if (game.round >= game.settings.rounds) {
          await this.finishGame();
          return;
        }
        game.round++;
        game.roster = this.presentGamePlayers()
          .sort(byJoinOrder)
          .map((m) => m.id);
        game.rosterIndex = 0;
        if (!game.roster.some((id) => this.members.get(id)?.presence === 'online')) {
          await this.interruptGame();
          return;
        }
      }
      const candidateId = game.roster[game.rosterIndex++]!;
      const candidate = this.members.get(candidateId);
      if (candidate && candidate.status === 'active' && candidate.presence === 'online') {
        await this.startChoosing(game, candidate);
        return;
      }
    }
    await this.interruptGame();
  }

  private async startChoosing(game: GameState, drawer: Member): Promise<void> {
    const gamePlayer = game.players.get(drawer.id)!;
    const candidates = pickWords(game.pool, game.usedWords, 3).map((word) => ({ id: randomToken(6), word }));
    const turnId = randomUUID();
    const turnIndex = ++game.turnCounter;
    const wall = this.deps.clock.wallNow();
    try {
      await this.deps.repo.createTurn({
        id: turnId,
        gameId: game.id,
        roundIndex: game.round,
        turnIndex,
        drawerGamePlayerId: gamePlayer.gamePlayerId,
        candidates,
        startedAt: new Date(wall),
      });
    } catch (err) {
      await this.failGame(err);
      return;
    }
    const turn: TurnState = {
      id: turnId,
      drawerId: drawer.id,
      drawerGamePlayerId: gamePlayer.gamePlayerId,
      round: game.round,
      status: 'choosing',
      candidates,
      choosingDeadline: wall + CHOOSE_TIME_MS,
      answer: null,
      answerKey: '',
      hintPositions: [],
      revealed: new Set(),
      startMono: 0,
      durationMs: game.settings.drawTimeSec * 1000,
      deadlineMono: 0,
      deadlineWall: 0,
      eligible: new Set(),
      pending: new Set(),
      correct: new Map(),
      canvas: new TurnCanvas(turnId),
      drawAcks: new Map(),
      lastCommit: Promise.resolve(),
      timers: [],
    };
    this.turn = turn;
    this.turnResult = null;
    this.phase = 'CHOOSING';
    turn.timers.push(this.timer(CHOOSE_TIME_MS, () => this.autoSelect(turnId)));
    this.broadcastState('turn:choosing');
    this.emitToMember(drawer, ServerEvents.wordChoices, {
      turnId,
      choices: candidates,
      deadline: turn.choosingDeadline,
    });
  }

  private async autoSelect(turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.status !== 'choosing') return;
    const choice = turn.candidates[randomInt(turn.candidates.length)]!;
    await this.startDrawing(turn, choice);
  }

  private async startDrawing(turn: TurnState, choice: WordChoice): Promise<void> {
    const game = this.game;
    if (!game) return;
    this.clearTurnTimers(turn);
    const now = this.deps.clock.now();
    const wall = this.deps.clock.wallNow();
    const durationMs = game.settings.drawTimeSec * 1000;
    try {
      await this.deps.repo.startDrawing({
        turnId: turn.id,
        answer: choice.word,
        drawingStartedAt: new Date(wall),
        deadline: new Date(wall + durationMs),
        durationMs,
      });
    } catch (err) {
      await this.failGame(err);
      return;
    }
    turn.answer = choice.word;
    turn.answerKey = guessKey(choice.word);
    turn.hintPositions = chooseHintPositions(choice.word);
    turn.status = 'drawing';
    turn.startMono = now;
    turn.durationMs = durationMs;
    turn.deadlineMono = now + durationMs;
    turn.deadlineWall = wall + durationMs;
    const guessers = this.presentGamePlayers()
      .filter((m) => m.id !== turn.drawerId)
      .map((m) => m.id);
    turn.eligible = new Set(guessers);
    turn.pending = new Set(guessers);
    this.phase = 'DRAWING';

    const turnId = turn.id;
    turn.timers.push(this.timer(durationMs, () => this.onDeadline(turnId)));
    hintSchedule(turn.hintPositions.length).forEach((fraction, index) => {
      turn.timers.push(this.timer(Math.floor(durationMs * fraction), () => this.revealHint(turnId, index)));
    });

    const drawer = this.members.get(turn.drawerId);
    if (drawer) this.emitToMember(drawer, ServerEvents.wordSelected, { turnId, word: choice.word });
    this.broadcastState('turn:started');
    if (turn.pending.size === 0) await this.endTurn('NO_GUESSERS');
  }

  private revealHint(turnId: string, index: number): void {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.status !== 'drawing') return;
    const position = turn.hintPositions[index];
    if (position === undefined) return;
    turn.revealed.add(position);
    this.broadcastState('word:hint');
  }

  private async onDeadline(turnId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.status !== 'drawing') return;
    await this.endTurn('TIME_UP');
  }

  private async handleChat(member: Member, text: string, receivedMono: number): Promise<ChatOutcome> {
    const turn = this.turn;
    if (turn && turn.status !== 'ended' && turn.drawerId === member.id) {
      throw new AppError('CHAT_LOCKED', 'The drawer cannot chat during their turn');
    }
    if (turn && turn.status === 'drawing') {
      if (turn.correct.has(member.id)) {
        throw new AppError('CHAT_LOCKED', 'You already guessed the word; chat reopens after the turn');
      }
      const key = guessKey(text);
      const matches = key.length > 0 && key === turn.answerKey;
      if (turn.eligible.has(member.id)) {
        const late = receivedMono >= turn.deadlineMono;
        if (matches && late) {
          this.emitToMember(member, ServerEvents.guessResult, { turnId: turn.id, status: 'late' });
          return { result: 'late' };
        }
        if (matches) return this.acceptCorrectGuess(turn, member, receivedMono);
        const close = !late && isCloseGuess(key, turn.answerKey);
        this.pushChat(member, text);
        if (close) {
          this.emitToMember(member, ServerEvents.guessResult, { turnId: turn.id, status: 'close', text });
        }
        return { result: close ? 'close' : 'incorrect' };
      }
      if (matches) {
        // A spectator typed the answer: never broadcast it.
        this.emitToMember(member, ServerEvents.guessResult, { turnId: turn.id, status: 'not_eligible' });
        return { result: 'not_eligible' };
      }
    }
    this.pushChat(member, text);
    return {};
  }

  private async acceptCorrectGuess(turn: TurnState, member: Member, receivedMono: number): Promise<ChatOutcome> {
    const game = this.game!;
    const gamePlayer = game.players.get(member.id)!;
    const points = guesserPoints(turn.deadlineMono - receivedMono, turn.durationMs);
    const receivedAt = new Date(this.deps.clock.wallNow() - (this.deps.clock.now() - receivedMono));
    let awarded: boolean;
    try {
      awarded = await this.deps.repo.awardGuess({
        turnId: turn.id,
        gamePlayerId: gamePlayer.gamePlayerId,
        points,
        receivedAt,
      });
    } catch (err) {
      this.deps.logger.error({ err, room: this.code }, 'could not record guess award');
      throw new AppError('UNAVAILABLE', 'Your guess could not be recorded, try again', 500);
    }
    if (awarded) gamePlayer.score += points;
    turn.correct.set(member.id, awarded ? points : 0);
    turn.pending.delete(member.id);
    this.deps.metrics?.inc('guesses_correct');
    this.emitToMember(member, ServerEvents.guessResult, { turnId: turn.id, status: 'correct', points });
    this.pushSystem('guessed', member);
    this.broadcastState('guess:correct');
    if (turn.pending.size === 0) await this.endTurn('ALL_GUESSED');
    return { result: 'correct' };
  }

  /** Closes the current turn exactly once, persists results, then schedules the next turn. */
  private async endTurn(reason: TurnEndReason): Promise<void> {
    const turn = this.turn;
    const game = this.game;
    if (!turn || !game || turn.status === 'ended') return;
    const wasDrawing = turn.status === 'drawing';
    turn.status = 'ended';
    this.clearTurnTimers(turn);
    await turn.lastCommit;

    const wall = this.deps.clock.wallNow();
    const points = wasDrawing ? drawerPoints(turn.correct.size) : 0;
    const finalCanvasSeq = turn.canvas.committedSeq;
    try {
      const finalized = await this.deps.repo.finalizeTurn({
        turnId: turn.id,
        drawerGamePlayerId: turn.drawerGamePlayerId,
        drawerPoints: points,
        endReason: reason,
        endedAt: new Date(wall),
        finalCanvasSeq,
      });
      const drawer = game.players.get(turn.drawerId);
      if (finalized && drawer) drawer.score += points;
    } catch (err) {
      await this.failGame(err);
      return;
    }
    this.deps.writer.forgetTurn(turn.id);
    this.deps.metrics?.inc('turns_ended');

    const deltas = [...turn.correct].map(([playerId, earned]) => ({ playerId, points: earned }));
    if (points > 0) deltas.push({ playerId: turn.drawerId, points });
    const terminal = reason === 'NOT_ENOUGH_PLAYERS' || reason === 'SERVER_RESTART';
    this.turnResult = {
      turnId: turn.id,
      drawerId: turn.drawerId,
      answer: wasDrawing ? turn.answer : null,
      reason,
      deltas,
      finalCanvasSeq,
      nextAt: terminal ? null : wall + INTERMISSION_MS,
    };
    this.phase = 'TURN_RESULT';
    this.broadcastState('turn:ended');
    if (terminal) {
      await this.interruptGame();
      return;
    }
    const turnId = turn.id;
    this.intermissionTimer = this.timer(INTERMISSION_MS, () => this.afterIntermission(turnId));
  }

  private async afterIntermission(turnId: string): Promise<void> {
    if (this.phase !== 'TURN_RESULT' || this.turn?.id !== turnId) return;
    await this.nextTurn();
  }

  private async finishGame(): Promise<void> {
    const game = this.game;
    if (!game) return;
    await this.deps.repo
      .endGame(game.id, 'FINISHED', new Date(this.deps.clock.wallNow()))
      .catch((err: unknown) => this.deps.logger.error({ err, room: this.code }, 'could not finish game'));
    this.gameResult = { gameId: game.id, status: 'FINISHED', ranking: this.ranking(game) };
    this.game = null;
    this.turn = null;
    this.phase = 'GAME_RESULT';
    this.deps.metrics?.inc('games_finished');
    this.broadcastState('game:ended');
  }

  /** Ends the game early (too few players, restart). Scores and replays are kept. */
  private async interruptGame(): Promise<void> {
    const game = this.game;
    if (!game) return;
    if (this.turn) this.clearTurnTimers(this.turn);
    this.deps.clock.clearTimeout(this.intermissionTimer);
    this.intermissionTimer = null;
    await this.deps.repo
      .endGame(game.id, 'INTERRUPTED', new Date(this.deps.clock.wallNow()))
      .catch((err: unknown) => this.deps.logger.error({ err, room: this.code }, 'could not interrupt game'));
    this.gameResult = { gameId: game.id, status: 'INTERRUPTED', ranking: this.ranking(game) };
    this.game = null;
    this.turn = null;
    this.turnResult = null;
    this.phase = 'LOBBY';
    this.deps.metrics?.inc('games_interrupted');
    this.broadcastState('game:interrupted');
  }

  /** A required write failed: stop accepting authoritative changes for this game. */
  private async failGame(err: unknown): Promise<void> {
    this.deps.logger.error({ err, room: this.code }, 'persistence failure; interrupting game');
    this.deps.metrics?.inc('games_failed');
    await this.interruptGame();
  }

  private onDrawFailure(turn: TurnState, err: unknown): void {
    if (turn.canvas.failed) return;
    turn.canvas.failed = true;
    this.deps.logger.error({ err, room: this.code, turnId: turn.id }, 'drawing persistence failed; rolling back');
    void this.queue
      .run(() => {
        if (!turn.canvas.failed) return;
        turn.canvas.rollbackToCommitted();
        const committed = new Set(turn.canvas.ops.map((op) => op.commandId));
        for (const commandId of turn.drawAcks.keys()) {
          if (!committed.has(commandId)) turn.drawAcks.delete(commandId);
        }
        this.deps.writer.resetTurn(turn.id);
      })
      .catch((error: unknown) => this.deps.logger.error({ err: error }, 'canvas rollback failed'));
  }

  // ------------------------------------------------------- membership flow

  private async enterGrace(member: Member): Promise<void> {
    member.presence = 'grace';
    member.gen++;
    this.armGraceTimer(member, this.deps.config.graceMs);
    await this.deps.repo.setRecoveryExpiry(
      [member.id],
      new Date(this.deps.clock.wallNow() + this.deps.config.graceMs),
    );
  }

  private armGraceTimer(member: Member, ms: number): void {
    this.deps.clock.clearTimeout(member.graceTimer);
    const gen = member.gen;
    member.graceTimer = this.timer(ms, () => this.expire(member.id, gen));
  }

  private async expire(memberId: string, gen: number): Promise<void> {
    const member = this.members.get(memberId);
    if (!member || member.gen !== gen || member.presence !== 'grace') return;
    member.presence = 'offline';
    member.graceTimer = null;
    await this.memberGone(member, 'expired');
  }

  private async memberGone(member: Member, how: 'left' | 'expired'): Promise<void> {
    if (this.isActiveDrawer(member.id)) {
      await this.endTurn(how === 'left' ? 'DRAWER_LEFT' : 'DRAWER_DISCONNECTED');
    } else {
      await this.removePendingGuesser(member.id);
    }
    if (this.hostId === member.id) await this.transferHost();
    await this.checkEnoughPlayers();
    if (how === 'left') this.pushSystem('left', member);
    this.broadcastState(how === 'left' ? 'player:left' : 'player:expired');
    if (!this.anyonePresent()) this.scheduleIdle();
  }

  private async removePendingGuesser(memberId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.status !== 'drawing') return;
    if (turn.pending.delete(memberId) && turn.pending.size === 0) {
      await this.endTurn(turn.correct.size > 0 ? 'ALL_GUESSED' : 'NO_GUESSERS');
    }
  }

  private async checkEnoughPlayers(): Promise<void> {
    if (!this.game || this.presentGamePlayers().length >= 2) return;
    if (this.turn && this.turn.status !== 'ended') await this.endTurn('NOT_ENOUGH_PLAYERS');
    else await this.interruptGame();
  }

  /** Makes sure the host is present; otherwise hands the role to the earliest connected member. */
  private async ensureHost(): Promise<boolean> {
    const host = this.hostId ? this.members.get(this.hostId) : undefined;
    if (host && host.status === 'active' && host.presence !== 'offline') return false;
    return this.transferHost();
  }

  private async transferHost(): Promise<boolean> {
    const next = this.presentMembers()
      .filter((m) => m.presence === 'online')
      .sort(byJoinOrder)[0];
    const nextId = next?.id ?? null;
    if (nextId === this.hostId) return false;
    this.hostId = nextId;
    await this.deps.repo.setRoomHost(this.id, nextId);
    if (next) this.pushSystem('host_changed', next);
    return true;
  }

  private async addGamePlayer(game: GameState, member: Member): Promise<void> {
    const gamePlayerId = await this.deps.repo.addGamePlayer(game.id, {
      membershipId: member.id,
      displayName: member.name,
      rosterPosition: game.nextRosterPosition++,
    });
    game.players.set(member.id, {
      gamePlayerId,
      membershipId: member.id,
      name: member.name,
      avatar: member.avatar,
      score: 0,
    });
  }

  private scheduleIdle(): void {
    if (this.idleTimer || this.closed) return;
    const expiresAt = this.deps.clock.wallNow() + this.deps.config.idleMs;
    this.idleTimer = this.timer(this.deps.config.idleMs, () => this.closeIfIdle());
    void this.deps.repo
      .setRoomIdle(this.id, new Date(expiresAt))
      .catch((err: unknown) => this.deps.logger.warn({ err, room: this.code }, 'could not mark room idle'));
  }

  private cancelIdle(): void {
    if (!this.idleTimer) return;
    this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    void this.deps.repo
      .setRoomIdle(this.id, null)
      .catch((err: unknown) => this.deps.logger.warn({ err, room: this.code }, 'could not clear room idle'));
  }

  private async closeIfIdle(): Promise<void> {
    this.idleTimer = null;
    if (this.closed || this.anyonePresent()) return;
    if (this.game) await this.interruptGame();
    await this.deps.repo.closeRoom(this.id);
    this.closed = true;
    this.clearAllTimers();
    this.deps.onClosed(this);
  }

  // ---------------------------------------------------------------- output

  private sendSnapshot(member: Member, socketId: string, request: SubscribeRequest): void {
    const snapshotId = randomToken(9);
    const turn = this.turn;
    let baseSeq = 0;
    let ops: AcceptedOperation[] = [];
    const canvasVisible = turn && (turn.status === 'drawing' || (turn.status === 'ended' && this.phase === 'TURN_RESULT'));
    if (turn && canvasVisible) {
      if (request.turnId === turn.id && request.canvasSeq !== undefined && request.canvasSeq <= turn.canvas.committedSeq) {
        baseSeq = request.canvasSeq;
      }
      ops = turn.canvas.committedOpsAfter(baseSeq);
    }
    const chunks = chunkOperations(ops);
    let secret: SnapshotPayload['you']['secret'] = null;
    if (turn && turn.drawerId === member.id && turn.status === 'choosing') {
      secret = { turnId: turn.id, choices: turn.candidates, word: null };
    } else if (turn && turn.drawerId === member.id && turn.status === 'drawing') {
      secret = { turnId: turn.id, choices: null, word: turn.answer };
    }
    const payload: SnapshotPayload = {
      snapshotId,
      eventSeq: this.eventSeq,
      serverNow: this.deps.clock.wallNow(),
      state: this.buildState(),
      you: {
        playerId: member.id,
        isHost: member.id === this.hostId,
        hostSettings: member.id === this.hostId ? this.settings : null,
        secret,
      },
      chat: [...this.chatLog],
      canvas: {
        turnId: canvasVisible && turn ? turn.id : null,
        baseSeq,
        throughSeq: canvasVisible && turn ? turn.canvas.committedSeq : 0,
        chunkCount: chunks.length,
      },
    };
    const { transport } = this.deps;
    transport.emitToSocket(socketId, ServerEvents.snapshot, payload);
    chunks.forEach((chunk, index) => {
      const event: CanvasChunkPayload = {
        snapshotId,
        turnId: turn!.id,
        index,
        last: index === chunks.length - 1,
        ops: chunk,
      };
      transport.emitToSocket(socketId, ServerEvents.canvasChunk, event);
    });
  }

  private buildState(): PublicRoomState {
    const game = this.game;
    const turn = this.turn;
    const lastScores = new Map(this.gameResult?.ranking.map((r) => [r.playerId, r.score]));
    const listed = new Map<string, Member>();
    for (const m of this.presentMembers()) listed.set(m.id, m);
    if (game) {
      for (const id of game.players.keys()) {
        const m = this.members.get(id);
        if (m) listed.set(id, m);
      }
    }
    const activeTurn = turn && turn.status !== 'ended' ? turn : null;
    const players: PublicPlayer[] = [...listed.values()].sort(byJoinOrder).map((m) => {
      let role: PublicPlayer['role'] = 'player';
      if (activeTurn?.drawerId === m.id) role = 'drawer';
      else if (game && (!game.players.has(m.id) || (activeTurn?.status === 'drawing' && !activeTurn.eligible.has(m.id)))) {
        role = 'spectator';
      }
      return {
        id: m.id,
        name: game?.players.get(m.id)?.name ?? m.name,
        avatar: m.avatar,
        isHost: m.id === this.hostId,
        connected: m.presence === 'online',
        present: m.status === 'active' && m.presence !== 'offline',
        score: game ? (game.players.get(m.id)?.score ?? null) : (lastScores.get(m.id) ?? null),
        role,
        guessed: turn?.correct.has(m.id) ?? false,
      };
    });
    let publicTurn: PublicTurn | null = null;
    if (turn) {
      publicTurn = {
        id: turn.id,
        drawerId: turn.drawerId,
        round: turn.round,
        status: turn.status,
        choosingDeadline: turn.status === 'choosing' ? turn.choosingDeadline : null,
        mask: turn.answer !== null && turn.status === 'drawing' ? buildMask(turn.answer, turn.revealed) : null,
        deadline: turn.status === 'drawing' ? turn.deadlineWall : null,
        durationMs: turn.answer !== null ? turn.durationMs : null,
        hintsRevealed: turn.revealed.size,
        guessedIds: [...turn.correct.keys()],
      };
    }
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: publicSettings(this.settings),
      settingsVersion: this.settingsVersion,
      minPlayers: this.deps.config.minPlayers,
      players,
      game: game ? { id: game.id, round: game.round, totalRounds: game.settings.rounds } : null,
      turn: publicTurn,
      turnResult: this.turnResult,
      gameResult: this.gameResult,
    };
  }

  private broadcastState(reason: string): void {
    this.eventSeq++;
    this.deps.transport.broadcast(this.channel, ServerEvents.state, {
      eventSeq: this.eventSeq,
      reason,
      state: this.buildState(),
    });
  }

  private pushChat(member: Member, text: string): void {
    this.deps.metrics?.inc('chat_messages');
    this.appendChat({
      id: ++this.chatSeq,
      at: this.deps.clock.wallNow(),
      kind: 'player',
      playerId: member.id,
      name: member.name,
      text,
    });
  }

  private pushSystem(event: Extract<ChatMessage, { kind: 'system' }>['event'], member: Member | null): void {
    this.appendChat({
      id: ++this.chatSeq,
      at: this.deps.clock.wallNow(),
      kind: 'system',
      event,
      playerId: member?.id ?? null,
      name: member?.name ?? null,
    });
  }

  private appendChat(message: ChatMessage): void {
    this.chatLog.push(message);
    if (this.chatLog.length > CHAT_LOG_SIZE) this.chatLog.shift();
    this.eventSeq++;
    this.deps.transport.broadcast(this.channel, ServerEvents.chat, { eventSeq: this.eventSeq, message });
  }

  private emitToMember(member: Member, event: string, payload: unknown): void {
    if (member.socketId) this.deps.transport.emitToSocket(member.socketId, event, payload);
  }

  // --------------------------------------------------------------- helpers

  private ranking(game: GameState): GameResult['ranking'] {
    return rankPlayers(
      [...game.players.values()].map((p) => ({ playerId: p.membershipId, name: p.name, avatar: p.avatar, score: p.score })),
    );
  }

  private memberBySession(sessionId: string): Member | undefined {
    for (const member of this.members.values()) {
      if (member.sessionId === sessionId) return member;
    }
    return undefined;
  }

  private requireController(memberId: string, socketId: string): Member {
    const member = this.members.get(memberId);
    if (!member || member.status !== 'active' || member.socketId !== socketId) {
      throw new AppError('NOT_MEMBER', 'This connection no longer controls the player; resubscribe');
    }
    return member;
  }

  private presentMembers(): Member[] {
    return [...this.members.values()].filter((m) => m.status === 'active' && m.presence !== 'offline');
  }

  private presentGamePlayers(): Member[] {
    const game = this.game;
    if (!game) return [];
    return this.presentMembers().filter((m) => game.players.has(m.id));
  }

  private anyonePresent(): boolean {
    return this.presentMembers().length > 0;
  }

  private isActiveDrawer(memberId: string): boolean {
    const turn = this.turn;
    return turn !== null && turn.status !== 'ended' && turn.drawerId === memberId;
  }

  private assertOpen(): void {
    if (this.closed) throw new AppError('ROOM_CLOSED', 'This room has closed');
  }

  private async settleDrawing(): Promise<void> {
    if (this.turn) await this.turn.lastCommit;
  }

  /** Timer whose callback runs inside the room queue. */
  private timer(ms: number, task: () => Promise<void> | void): TimerHandle {
    return this.deps.clock.setTimeout(() => {
      void this.queue
        .run(task)
        .catch((err: unknown) => this.deps.logger.error({ err, room: this.code }, 'room timer task failed'));
    }, ms);
  }

  private clearTurnTimers(turn: TurnState): void {
    for (const handle of turn.timers) this.deps.clock.clearTimeout(handle);
    turn.timers = [];
  }

  private clearAllTimers(): void {
    if (this.turn) this.clearTurnTimers(this.turn);
    this.deps.clock.clearTimeout(this.intermissionTimer);
    this.deps.clock.clearTimeout(this.idleTimer);
    this.intermissionTimer = null;
    this.idleTimer = null;
    for (const member of this.members.values()) {
      this.deps.clock.clearTimeout(member.graceTimer);
      member.graceTimer = null;
    }
  }
}

function byJoinOrder(a: { joinedAt: number; id: string }, b: { joinedAt: number; id: string }): number {
  return a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function chunkOperations(ops: readonly AcceptedOperation[]): AcceptedOperation[][] {
  const chunks: AcceptedOperation[][] = [];
  let current: AcceptedOperation[] = [];
  let size = 0;
  for (const op of ops) {
    const bytes = Buffer.byteLength(JSON.stringify(op), 'utf8');
    if (current.length > 0 && size + bytes > SNAPSHOT_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
