/**
 * Socket.IO protocol. The web app keeps a matching copy of the types; it must
 * never import server code.
 *
 * Public events carry a room-wide `eventSeq` so clients can detect gaps and
 * resubscribe. Drawing operations use a separate per-turn `canvasSeq`.
 * Private events (to one player) never consume an `eventSeq`.
 */
import { z } from 'zod';
import { drawOperationSchema, type AcceptedOperation } from '../drawing/operations.js';
import type { ErrorCode } from '../lib/errors.js';
import type { PublicSettings, RoomSettings } from '../game/settings.js';

export const ClientEvents = {
  subscribe: 'room:subscribe',
  leave: 'room:leave',
  startGame: 'game:start',
  returnToLobby: 'room:lobby',
  selectWord: 'word:select',
  draw: 'draw:operation',
  chat: 'chat:send',
  timeSync: 'time:sync',
} as const;

export const ServerEvents = {
  /** Full public state for one subscriber, followed by `canvas:chunk` events. */
  snapshot: 'room:snapshot',
  canvasChunk: 'canvas:chunk',
  /** Public state change. `reason` says what happened (turn:started, word:hint, ...). */
  state: 'room:state',
  chat: 'chat:message',
  draw: 'draw:operation',
  /** Private to the drawer. */
  wordChoices: 'word:choices',
  wordSelected: 'word:selected',
  /** Private to the guesser. */
  guessResult: 'guess:result',
  /** Private: another tab took over this player's connection. */
  replaced: 'room:replaced',
  draining: 'server:draining',
} as const;

const commandId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const turnId = z.uuid();

export const subscribeSchema = z.strictObject({
  commandId,
  code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  lastEventSeq: z.number().int().min(0).optional(),
  turnId: turnId.optional(),
  canvasSeq: z.number().int().min(0).optional(),
});

export const simpleCommandSchema = z.strictObject({ commandId });

export const selectWordSchema = z.strictObject({
  commandId,
  turnId,
  candidateId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
});

export const drawCommandSchema = z.strictObject({
  commandId,
  turnId,
  op: drawOperationSchema,
});

export const chatCommandSchema = z.strictObject({
  commandId,
  // Transport bound; cleanChat applies the 200 character / 1 KiB rule.
  text: z.string().min(1).max(1024),
});

export const timeSyncSchema = z.strictObject({ commandId: commandId.optional() });

export interface Ack {
  commandId: string | null;
  ok: boolean;
  code?: ErrorCode;
  message?: string;
  retryAfterMs?: number;
  eventSeq?: number;
  canvasSeq?: number;
  actionId?: string;
  result?: GuessStatus;
  serverNow?: number;
}

export type Phase = 'LOBBY' | 'CHOOSING' | 'DRAWING' | 'TURN_RESULT' | 'GAME_RESULT';

export type TurnEndReason =
  | 'TIME_UP'
  | 'ALL_GUESSED'
  | 'DRAWER_DISCONNECTED'
  | 'DRAWER_LEFT'
  | 'NO_GUESSERS'
  | 'NOT_ENOUGH_PLAYERS'
  | 'SERVER_RESTART'
  | 'PERSISTENCE_FAILURE';

export interface PublicPlayer {
  id: string;
  name: string;
  isHost: boolean;
  /** Has a live socket right now. */
  connected: boolean;
  /** In the room (online or within the reconnect grace period). */
  present: boolean;
  /** Score in the current or last game; null when no game has been played. */
  score: number | null;
  role: 'player' | 'drawer' | 'spectator';
  guessed: boolean;
}

export interface PublicTurn {
  id: string;
  drawerId: string;
  round: number;
  status: 'choosing' | 'drawing' | 'ended';
  /** Wall-clock ms (server time) when the drawer must have chosen. */
  choosingDeadline: number | null;
  /** Hidden letters are "_"; spaces and punctuation are visible. */
  mask: string | null;
  deadline: number | null;
  durationMs: number | null;
  hintsRevealed: number;
  guessedIds: string[];
}

export interface TurnResult {
  turnId: string;
  drawerId: string;
  /** Null when the drawer never picked a word. */
  answer: string | null;
  reason: TurnEndReason;
  deltas: Array<{ playerId: string; points: number }>;
  finalCanvasSeq: number;
  nextAt: number | null;
}

export interface GameResult {
  gameId: string;
  status: 'FINISHED' | 'INTERRUPTED';
  ranking: Array<{ playerId: string; name: string; score: number; rank: number }>;
}

export interface PublicRoomState {
  code: string;
  phase: Phase;
  hostId: string | null;
  settings: PublicSettings;
  settingsVersion: number;
  minPlayers: number;
  players: PublicPlayer[];
  game: { id: string; round: number; totalRounds: number } | null;
  turn: PublicTurn | null;
  turnResult: TurnResult | null;
  gameResult: GameResult | null;
}

export type ChatMessage =
  | { id: number; at: number; kind: 'player'; playerId: string; name: string; text: string }
  | {
      id: number;
      at: number;
      kind: 'system';
      event: 'joined' | 'left' | 'guessed' | 'game_started' | 'host_changed';
      playerId: string | null;
      name: string | null;
    };

export type GuessStatus = 'correct' | 'close' | 'incorrect' | 'not_eligible' | 'late';

export interface SnapshotPayload {
  snapshotId: string;
  eventSeq: number;
  serverNow: number;
  state: PublicRoomState;
  you: {
    playerId: string;
    isHost: boolean;
    /** Only for the host: full settings including the custom word list. */
    hostSettings: RoomSettings | null;
    /** Only for the current drawer. */
    secret: { turnId: string; choices: WordChoice[] | null; word: string | null } | null;
  };
  chat: ChatMessage[];
  canvas: {
    turnId: string | null;
    /** Operations after this sequence follow in `canvas:chunk` events. */
    baseSeq: number;
    throughSeq: number;
    chunkCount: number;
  };
}

export interface CanvasChunkPayload {
  snapshotId: string;
  turnId: string;
  index: number;
  last: boolean;
  ops: AcceptedOperation[];
}

export interface WordChoice {
  id: string;
  word: string;
}

export interface StateEvent {
  eventSeq: number;
  reason: string;
  state: PublicRoomState;
}

export interface ChatEvent {
  eventSeq: number;
  message: ChatMessage;
}
