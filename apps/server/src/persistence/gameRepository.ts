import type { AcceptedOperation } from '../drawing/operations.js';
import type { GameRepository, LoadedRoom, NewGamePlayer } from '../game/repository.js';
import { parseStoredSettings, type FrozenGameSettings, type RoomSettings } from '../game/settings.js';
import type { TurnEndReason, WordChoice } from '../realtime/protocol.js';
import { isUniqueViolation, type Prisma, type PrismaClient } from './prisma.js';

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class PrismaGameRepository implements GameRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async loadRoom(code: string): Promise<LoadedRoom | null> {
    const room = await this.prisma.room.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        status: true,
        hostMembershipId: true,
        settings: true,
        settingsVersion: true,
        memberships: {
          select: {
            id: true,
            sessionId: true,
            joinedAt: true,
            status: true,
            recoveryExpiresAt: true,
            session: { select: { displayName: true, avatar: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
      },
    });
    if (!room) return null;
    return {
      id: room.id,
      code: room.code,
      status: room.status,
      hostMembershipId: room.hostMembershipId,
      settings: parseStoredSettings(room.settings),
      settingsVersion: room.settingsVersion,
      members: room.memberships.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        displayName: m.session.displayName,
        avatar: [m.session.avatar[0] ?? 0, m.session.avatar[1] ?? 0, m.session.avatar[2] ?? 0],
        joinedAt: m.joinedAt,
        status: m.status,
        recoveryExpiresAt: m.recoveryExpiresAt,
      })),
    };
  }

  async upsertMembership(roomId: string, sessionId: string): Promise<{ id: string; joinedAt: Date }> {
    const membership = await this.prisma.membership.upsert({
      where: { roomId_sessionId: { roomId, sessionId } },
      create: { roomId, sessionId },
      update: { status: 'ACTIVE' },
      select: { id: true, joinedAt: true },
    });
    return membership;
  }

  async setMembershipStatus(id: string, status: 'ACTIVE' | 'LEFT', recoveryExpiresAt: Date | null): Promise<void> {
    await this.prisma.membership.update({ where: { id }, data: { status, recoveryExpiresAt } });
  }

  async setRecoveryExpiry(ids: readonly string[], recoveryExpiresAt: Date | null): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.membership.updateMany({ where: { id: { in: [...ids] } }, data: { recoveryExpiresAt } });
  }

  async setRoomHost(roomId: string, membershipId: string | null): Promise<void> {
    await this.prisma.room.update({ where: { id: roomId }, data: { hostMembershipId: membershipId } });
  }

  async setRoomIdle(roomId: string, idleExpiresAt: Date | null): Promise<void> {
    await this.prisma.room.update({ where: { id: roomId }, data: { idleExpiresAt } });
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.prisma.room.update({ where: { id: roomId }, data: { status: 'CLOSED' } });
  }

  async saveSettings(roomId: string, settings: RoomSettings, expectedVersion: number): Promise<number | null> {
    const result = await this.prisma.room.updateMany({
      where: { id: roomId, settingsVersion: expectedVersion },
      data: { settings: json(settings), settingsVersion: { increment: 1 } },
    });
    return result.count === 1 ? expectedVersion + 1 : null;
  }

  async createGame(input: {
    roomId: string;
    settings: FrozenGameSettings;
    players: readonly NewGamePlayer[];
  }): Promise<{ gameId: string; players: Array<{ membershipId: string; gamePlayerId: string }> }> {
    const game = await this.prisma.game.create({
      data: {
        roomId: input.roomId,
        settings: json(input.settings),
        players: { create: input.players.map((p) => ({ ...p })) },
      },
      select: { id: true, players: { select: { id: true, membershipId: true } } },
    });
    return {
      gameId: game.id,
      players: game.players.map((p) => ({ membershipId: p.membershipId, gamePlayerId: p.id })),
    };
  }

  async addGamePlayer(gameId: string, player: NewGamePlayer): Promise<string> {
    const row = await this.prisma.gamePlayer.upsert({
      where: { gameId_membershipId: { gameId, membershipId: player.membershipId } },
      create: { gameId, ...player },
      update: {},
      select: { id: true },
    });
    return row.id;
  }

  async createTurn(input: {
    id: string;
    gameId: string;
    roundIndex: number;
    turnIndex: number;
    drawerGamePlayerId: string;
    candidates: WordChoice[];
    startedAt: Date;
  }): Promise<void> {
    await this.prisma.turn.create({
      data: {
        id: input.id,
        gameId: input.gameId,
        roundIndex: input.roundIndex,
        turnIndex: input.turnIndex,
        drawerId: input.drawerGamePlayerId,
        candidates: json(input.candidates),
        status: 'CHOOSING',
        startedAt: input.startedAt,
      },
    });
  }

  async startDrawing(input: {
    turnId: string;
    answer: string;
    drawingStartedAt: Date;
    deadline: Date;
    durationMs: number;
  }): Promise<void> {
    await this.prisma.turn.update({
      where: { id: input.turnId },
      data: {
        answer: input.answer,
        status: 'DRAWING',
        drawingStartedAt: input.drawingStartedAt,
        deadline: input.deadline,
        durationMs: input.durationMs,
      },
    });
  }

  async awardGuess(input: { turnId: string; gamePlayerId: string; points: number; receivedAt: Date }): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.guessAward.create({ data: input }),
        this.prisma.gamePlayer.update({
          where: { id: input.gamePlayerId },
          data: { score: { increment: input.points } },
        }),
      ]);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async finalizeTurn(input: {
    turnId: string;
    drawerGamePlayerId: string;
    drawerPoints: number;
    endReason: TurnEndReason;
    endedAt: Date;
    finalCanvasSeq: number;
  }): Promise<boolean> {
    try {
      await this.prisma.$transaction([
        this.prisma.turnFinalization.create({
          data: { turnId: input.turnId, drawerPoints: input.drawerPoints, finalizedAt: input.endedAt },
        }),
        this.prisma.gamePlayer.update({
          where: { id: input.drawerGamePlayerId },
          data: { score: { increment: input.drawerPoints } },
        }),
        this.prisma.turn.update({
          where: { id: input.turnId },
          data: {
            status: 'ENDED',
            endReason: input.endReason,
            endedAt: input.endedAt,
            finalCanvasSeq: input.finalCanvasSeq,
          },
        }),
      ]);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async endGame(gameId: string, status: 'FINISHED' | 'INTERRUPTED', endedAt: Date): Promise<void> {
    await this.prisma.game.updateMany({
      where: { id: gameId, status: 'IN_PROGRESS' },
      data: { status, endedAt },
    });
  }

  async appendDrawingOperations(ops: readonly AcceptedOperation[]): Promise<void> {
    if (ops.length === 0) return;
    await this.prisma.drawingOperation.createMany({
      data: ops.map((op) => ({
        turnId: op.turnId,
        canvasSeq: op.canvasSeq,
        commandId: op.commandId,
        actionId: op.actionId,
        elapsedMs: op.elapsedMs,
        payload: json(op.operation),
      })),
    });
  }
}
