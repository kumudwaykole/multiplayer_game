import type { AcceptedOperation } from '../drawing/operations.js';
import type { TurnEndReason } from '../realtime/protocol.js';
import type { FrozenGameSettings, RoomSettings } from './settings.js';
import type { WordChoice } from '../realtime/protocol.js';

export interface StoredMember {
  id: string;
  sessionId: string;
  displayName: string;
  joinedAt: Date;
  status: 'ACTIVE' | 'LEFT';
  recoveryExpiresAt: Date | null;
}

export interface LoadedRoom {
  id: string;
  code: string;
  status: 'OPEN' | 'CLOSED';
  hostMembershipId: string | null;
  settings: RoomSettings;
  settingsVersion: number;
  members: StoredMember[];
}

export interface NewGamePlayer {
  membershipId: string;
  displayName: string;
  rosterPosition: number;
}

/**
 * Everything the room runtime persists. Implemented with Prisma in
 * production and in memory for rule tests.
 */
export interface GameRepository {
  loadRoom(code: string): Promise<LoadedRoom | null>;
  /** Creates the membership, or reactivates an existing one for this session. */
  upsertMembership(roomId: string, sessionId: string): Promise<{ id: string; joinedAt: Date }>;
  setMembershipStatus(id: string, status: 'ACTIVE' | 'LEFT', recoveryExpiresAt: Date | null): Promise<void>;
  setRecoveryExpiry(ids: readonly string[], recoveryExpiresAt: Date | null): Promise<void>;
  setRoomHost(roomId: string, membershipId: string | null): Promise<void>;
  setRoomIdle(roomId: string, idleExpiresAt: Date | null): Promise<void>;
  closeRoom(roomId: string): Promise<void>;
  /** Returns the new version, or null if `expectedVersion` is stale. */
  saveSettings(roomId: string, settings: RoomSettings, expectedVersion: number): Promise<number | null>;
  createGame(input: {
    roomId: string;
    settings: FrozenGameSettings;
    players: readonly NewGamePlayer[];
  }): Promise<{ gameId: string; players: Array<{ membershipId: string; gamePlayerId: string }> }>;
  /** Idempotent per (game, membership). Returns the game player ID. */
  addGamePlayer(gameId: string, player: NewGamePlayer): Promise<string>;
  createTurn(input: {
    id: string;
    gameId: string;
    roundIndex: number;
    turnIndex: number;
    drawerGamePlayerId: string;
    candidates: WordChoice[];
    startedAt: Date;
  }): Promise<void>;
  startDrawing(input: {
    turnId: string;
    answer: string;
    drawingStartedAt: Date;
    deadline: Date;
    durationMs: number;
  }): Promise<void>;
  /** Award + score increment in one transaction. False if this player was already awarded. */
  awardGuess(input: { turnId: string; gamePlayerId: string; points: number; receivedAt: Date }): Promise<boolean>;
  /** Finalization + drawer increment + turn close in one transaction. False if already finalized. */
  finalizeTurn(input: {
    turnId: string;
    drawerGamePlayerId: string;
    drawerPoints: number;
    endReason: TurnEndReason;
    endedAt: Date;
    finalCanvasSeq: number;
  }): Promise<boolean>;
  endGame(gameId: string, status: 'FINISHED' | 'INTERRUPTED', endedAt: Date): Promise<void>;
  appendDrawingOperations(ops: readonly AcceptedOperation[]): Promise<void>;
}
