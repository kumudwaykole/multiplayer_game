import { randomUUID } from 'node:crypto';
import type { AcceptedOperation } from '../../src/drawing/operations.js';
import type { GameRepository, LoadedRoom, NewGamePlayer, StoredMember } from '../../src/game/repository.js';
import type { FrozenGameSettings, RoomSettings } from '../../src/game/settings.js';
import type { TurnEndReason, WordChoice } from '../../src/realtime/protocol.js';

interface MemoryTurn {
  id: string;
  gameId: string;
  drawerGamePlayerId: string;
  candidates: WordChoice[];
  answer: string | null;
  status: 'CHOOSING' | 'DRAWING' | 'ENDED';
  endReason: TurnEndReason | null;
  finalCanvasSeq: number | null;
}

/** In-memory GameRepository with the same uniqueness guarantees as the database. */
export class MemoryRepository implements GameRepository {
  readonly room: {
    id: string;
    code: string;
    status: 'OPEN' | 'CLOSED';
    hostMembershipId: string | null;
    settings: RoomSettings;
    settingsVersion: number;
    idleExpiresAt: Date | null;
  };
  readonly members = new Map<string, StoredMember>();
  readonly games = new Map<string, { settings: FrozenGameSettings; status: string }>();
  readonly gamePlayers = new Map<string, { gameId: string; membershipId: string; score: number }>();
  readonly turns = new Map<string, MemoryTurn>();
  readonly awards = new Map<string, number>();
  readonly finalized = new Set<string>();
  readonly operations: AcceptedOperation[] = [];
  /** Number of upcoming drawing writes that should fail. */
  failDrawingWrites = 0;

  constructor(code: string, settings: RoomSettings) {
    this.room = {
      id: randomUUID(),
      code,
      status: 'OPEN',
      hostMembershipId: null,
      settings,
      settingsVersion: 0,
      idleExpiresAt: null,
    };
  }

  async loadRoom(code: string): Promise<LoadedRoom | null> {
    if (code !== this.room.code) return null;
    return {
      id: this.room.id,
      code: this.room.code,
      status: this.room.status,
      hostMembershipId: this.room.hostMembershipId,
      settings: this.room.settings,
      settingsVersion: this.room.settingsVersion,
      members: [...this.members.values()].map((m) => ({ ...m })),
    };
  }

  async upsertMembership(_roomId: string, sessionId: string): Promise<{ id: string; joinedAt: Date }> {
    for (const member of this.members.values()) {
      if (member.sessionId === sessionId) {
        member.status = 'ACTIVE';
        return { id: member.id, joinedAt: member.joinedAt };
      }
    }
    const member: StoredMember = {
      id: randomUUID(),
      sessionId,
      displayName: sessionId,
      // Strictly increasing so join order is deterministic.
      joinedAt: new Date(Date.UTC(2026, 0, 1) + this.members.size * 1000),
      status: 'ACTIVE',
      recoveryExpiresAt: null,
    };
    this.members.set(member.id, member);
    return { id: member.id, joinedAt: member.joinedAt };
  }

  async setMembershipStatus(id: string, status: 'ACTIVE' | 'LEFT', recoveryExpiresAt: Date | null): Promise<void> {
    const member = this.members.get(id)!;
    member.status = status;
    member.recoveryExpiresAt = recoveryExpiresAt;
  }

  async setRecoveryExpiry(ids: readonly string[], recoveryExpiresAt: Date | null): Promise<void> {
    for (const id of ids) {
      const member = this.members.get(id);
      if (member) member.recoveryExpiresAt = recoveryExpiresAt;
    }
  }

  async setRoomHost(_roomId: string, membershipId: string | null): Promise<void> {
    this.room.hostMembershipId = membershipId;
  }

  async setRoomIdle(_roomId: string, idleExpiresAt: Date | null): Promise<void> {
    this.room.idleExpiresAt = idleExpiresAt;
  }

  async closeRoom(): Promise<void> {
    this.room.status = 'CLOSED';
  }

  async saveSettings(_roomId: string, settings: RoomSettings, expectedVersion: number): Promise<number | null> {
    if (expectedVersion !== this.room.settingsVersion) return null;
    this.room.settings = settings;
    this.room.settingsVersion++;
    return this.room.settingsVersion;
  }

  async createGame(input: { roomId: string; settings: FrozenGameSettings; players: readonly NewGamePlayer[] }) {
    const gameId = randomUUID();
    this.games.set(gameId, { settings: input.settings, status: 'IN_PROGRESS' });
    const players = input.players.map((p) => {
      const gamePlayerId = randomUUID();
      this.gamePlayers.set(gamePlayerId, { gameId, membershipId: p.membershipId, score: 0 });
      return { membershipId: p.membershipId, gamePlayerId };
    });
    return { gameId, players };
  }

  async addGamePlayer(gameId: string, player: NewGamePlayer): Promise<string> {
    for (const [id, gp] of this.gamePlayers) {
      if (gp.gameId === gameId && gp.membershipId === player.membershipId) return id;
    }
    const id = randomUUID();
    this.gamePlayers.set(id, { gameId, membershipId: player.membershipId, score: 0 });
    return id;
  }

  async createTurn(input: {
    id: string;
    gameId: string;
    drawerGamePlayerId: string;
    candidates: WordChoice[];
  }): Promise<void> {
    this.turns.set(input.id, {
      id: input.id,
      gameId: input.gameId,
      drawerGamePlayerId: input.drawerGamePlayerId,
      candidates: input.candidates,
      answer: null,
      status: 'CHOOSING',
      endReason: null,
      finalCanvasSeq: null,
    });
  }

  async startDrawing(input: { turnId: string; answer: string }): Promise<void> {
    const turn = this.turns.get(input.turnId)!;
    turn.answer = input.answer;
    turn.status = 'DRAWING';
  }

  async awardGuess(input: { turnId: string; gamePlayerId: string; points: number }): Promise<boolean> {
    const key = `${input.turnId}:${input.gamePlayerId}`;
    if (this.awards.has(key)) return false;
    this.awards.set(key, input.points);
    this.gamePlayers.get(input.gamePlayerId)!.score += input.points;
    return true;
  }

  async finalizeTurn(input: {
    turnId: string;
    drawerGamePlayerId: string;
    drawerPoints: number;
    endReason: TurnEndReason;
    finalCanvasSeq: number;
  }): Promise<boolean> {
    if (this.finalized.has(input.turnId)) return false;
    this.finalized.add(input.turnId);
    this.gamePlayers.get(input.drawerGamePlayerId)!.score += input.drawerPoints;
    const turn = this.turns.get(input.turnId)!;
    turn.status = 'ENDED';
    turn.endReason = input.endReason;
    turn.finalCanvasSeq = input.finalCanvasSeq;
    return true;
  }

  async endGame(gameId: string, status: 'FINISHED' | 'INTERRUPTED'): Promise<void> {
    const game = this.games.get(gameId)!;
    if (game.status === 'IN_PROGRESS') game.status = status;
  }

  async appendDrawingOperations(ops: readonly AcceptedOperation[]): Promise<void> {
    if (this.failDrawingWrites > 0) {
      this.failDrawingWrites--;
      throw new Error('simulated database failure');
    }
    for (const op of ops) {
      if (this.operations.some((o) => o.turnId === op.turnId && (o.canvasSeq === op.canvasSeq || o.commandId === op.commandId))) {
        throw new Error('unique violation');
      }
    }
    this.operations.push(...ops);
  }
}
