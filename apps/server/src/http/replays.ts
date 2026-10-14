import type { AcceptedOperation, DrawOperation } from '../drawing/operations.js';
import { AppError } from '../lib/errors.js';
import type { PrismaClient } from '../persistence/prisma.js';

export const REPLAY_PAGE_OPS = 500;
export const REPLAY_PAGE_BYTES = 512 * 1024;

export interface ReplayIndex {
  gameId: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'INTERRUPTED';
  turns: Array<{
    turnId: string;
    round: number;
    turnIndex: number;
    drawer: { playerId: string; name: string };
    answer: string | null;
    endReason: string | null;
    durationMs: number | null;
    operationCount: number;
  }>;
}

export interface ReplayPage {
  turnId: string;
  ops: AcceptedOperation[];
  nextAfterSeq: number | null;
}

async function requireMembership(prisma: PrismaClient, roomId: string, sessionId: string): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { roomId_sessionId: { roomId, sessionId } },
    select: { id: true },
  });
  // Same error for "missing" and "not yours" so IDs cannot be probed.
  if (!membership) throw new AppError('NOT_FOUND', 'Replay not found');
}

/** Ended turns of a game. Only ended turns are listed, so no active answer can leak. */
export async function replayIndex(prisma: PrismaClient, gameId: string, sessionId: string): Promise<ReplayIndex> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      id: true,
      roomId: true,
      status: true,
      turns: {
        where: { status: 'ENDED' },
        orderBy: { turnIndex: 'asc' },
        select: {
          id: true,
          roundIndex: true,
          turnIndex: true,
          answer: true,
          endReason: true,
          durationMs: true,
          drawingStartedAt: true,
          drawer: { select: { membershipId: true, displayName: true } },
          _count: { select: { operations: true } },
        },
      },
    },
  });
  if (!game) throw new AppError('NOT_FOUND', 'Replay not found');
  await requireMembership(prisma, game.roomId, sessionId);
  return {
    gameId: game.id,
    status: game.status,
    turns: game.turns.map((turn) => ({
      turnId: turn.id,
      round: turn.roundIndex,
      turnIndex: turn.turnIndex,
      drawer: { playerId: turn.drawer.membershipId, name: turn.drawer.displayName },
      // A word that was never chosen stays private.
      answer: turn.drawingStartedAt ? turn.answer : null,
      endReason: turn.endReason,
      durationMs: turn.durationMs,
      operationCount: turn._count.operations,
    })),
  };
}

/** One page of a finished drawing, by sequence (never by offset). */
export async function replayPage(
  prisma: PrismaClient,
  turnId: string,
  sessionId: string,
  afterSeq: number,
): Promise<ReplayPage> {
  const turn = await prisma.turn.findUnique({
    where: { id: turnId },
    select: { id: true, status: true, game: { select: { roomId: true } } },
  });
  if (!turn || turn.status !== 'ENDED') throw new AppError('NOT_FOUND', 'Replay not found');
  await requireMembership(prisma, turn.game.roomId, sessionId);

  const rows = await prisma.drawingOperation.findMany({
    where: { turnId, canvasSeq: { gt: afterSeq } },
    orderBy: { canvasSeq: 'asc' },
    take: REPLAY_PAGE_OPS + 1,
    select: { canvasSeq: true, commandId: true, actionId: true, elapsedMs: true, payload: true },
  });
  const ops: AcceptedOperation[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, REPLAY_PAGE_OPS)) {
    const op: AcceptedOperation = {
      turnId,
      canvasSeq: row.canvasSeq,
      commandId: row.commandId,
      elapsedMs: row.elapsedMs,
      actionId: row.actionId,
      operation: row.payload as DrawOperation,
    };
    const size = Buffer.byteLength(JSON.stringify(op), 'utf8');
    if (ops.length > 0 && bytes + size > REPLAY_PAGE_BYTES) break;
    ops.push(op);
    bytes += size;
  }
  const more = ops.length < rows.length;
  return { turnId, ops, nextAfterSeq: more ? ops.at(-1)!.canvasSeq : null };
}
