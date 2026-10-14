/**
 * Client copy of the realtime protocol (types only). Source of truth:
 * apps/server/src/realtime/protocol.ts. The browser never imports server code.
 */

export type Avatar = [number, number, number];

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
  avatar: Avatar;
  isHost: boolean;
  connected: boolean;
  present: boolean;
  score: number | null;
  role: 'player' | 'drawer' | 'spectator';
  guessed: boolean;
}

export interface PublicTurn {
  id: string;
  drawerId: string;
  round: number;
  status: 'choosing' | 'drawing' | 'ended';
  choosingDeadline: number | null;
  mask: string | null;
  deadline: number | null;
  durationMs: number | null;
  hintsRevealed: number;
  guessedIds: string[];
}

export interface TurnResult {
  turnId: string;
  drawerId: string;
  answer: string | null;
  reason: TurnEndReason;
  deltas: Array<{ playerId: string; points: number }>;
  finalCanvasSeq: number;
  nextAt: number | null;
}

export interface RankedPlayer {
  playerId: string;
  name: string;
  avatar: Avatar;
  score: number;
  rank: number;
}

export interface GameResult {
  gameId: string;
  status: 'FINISHED' | 'INTERRUPTED';
  ranking: RankedPlayer[];
}

export interface PublicSettings {
  rounds: number;
  drawTimeSec: number;
  maxPlayers: number;
  wordMode: 'builtin' | 'custom';
  customWordCount: number;
}

export interface RoomSettings {
  rounds: number;
  drawTimeSec: number;
  maxPlayers: number;
  wordMode: 'builtin' | 'custom';
  customWords: string[];
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

export type SystemEvent = 'joined' | 'left' | 'guessed' | 'game_started' | 'host_changed';

export type ChatMessage =
  | { id: number; at: number; kind: 'player'; playerId: string; name: string; text: string }
  | { id: number; at: number; kind: 'system'; event: SystemEvent; playerId: string | null; name: string | null };

export interface WordChoice {
  id: string;
  word: string;
}

export type GuessStatus = 'correct' | 'close' | 'incorrect' | 'not_eligible' | 'late';

export interface SnapshotPayload {
  snapshotId: string;
  eventSeq: number;
  serverNow: number;
  state: PublicRoomState;
  you: {
    playerId: string;
    isHost: boolean;
    hostSettings: RoomSettings | null;
    secret: { turnId: string; choices: WordChoice[] | null; word: string | null } | null;
  };
  chat: ChatMessage[];
  canvas: { turnId: string | null; baseSeq: number; throughSeq: number; chunkCount: number };
}

export interface CanvasChunkPayload {
  snapshotId: string;
  turnId: string;
  index: number;
  last: boolean;
  ops: AcceptedOperation[];
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

export interface Ack {
  commandId: string | null;
  ok: boolean;
  code?: string;
  message?: string;
  retryAfterMs?: number;
  canvasSeq?: number;
  actionId?: string;
  result?: GuessStatus;
  serverNow?: number;
}

export type Point = [number, number];

export type DrawOperation =
  | { type: 'stroke.begin'; strokeId: string; tool: 'pen' | 'eraser'; color: string; width: number; point: Point }
  | { type: 'stroke.points'; strokeId: string; points: Point[] }
  | { type: 'stroke.end'; strokeId: string }
  | { type: 'fill'; point: Point; color: string }
  | { type: 'undo'; targetActionId: string }
  | { type: 'clear' };

export interface AcceptedOperation {
  turnId: string;
  commandId: string;
  canvasSeq: number;
  elapsedMs: number;
  actionId: string;
  operation: DrawOperation;
}

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 700;
export const MAX_POINTS_PER_BATCH = 64;
export const CHAT_MAX_CHARS = 200;
export const NAME_MAX_CHARS = 24;
