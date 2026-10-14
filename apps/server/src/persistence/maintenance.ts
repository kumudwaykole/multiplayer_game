import { readdir } from 'node:fs/promises';
import type { Logger } from 'pino';
import { drawerPoints } from '../game/scoring.js';
import type { PrismaClient } from './prisma.js';

/** True when every migration shipped with the app is recorded as applied. */
export async function migrationsApplied(prisma: PrismaClient, dir: string): Promise<boolean> {
  let expected: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    expected = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return false;
  }
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const applied = new Set(rows.map((row) => row.migration_name));
    return expected.length > 0 && expected.every((name) => applied.has(name));
  } catch {
    return false;
  }
}

/**
 * Startup policy for a single authoritative instance: in-progress turns
 * close as SERVER_RESTART (committed awards stand and the drawer gets their
 * points once), in-progress games become INTERRUPTED, and every committed
 * drawing operation stays available for replay. Rooms reload into the lobby
 * on demand.
 */
export async function reconcileAfterRestart(
  prisma: PrismaClient,
  roomIdleMs: number,
  logger: Logger,
): Promise<{ turns: number; games: number }> {
  const now = new Date();
  const result = await prisma.$transaction(
    async (tx) => {
      const openTurns = await tx.turn.findMany({
        where: { status: { in: ['CHOOSING', 'DRAWING'] } },
        select: {
          id: true,
          status: true,
          drawerId: true,
          finalization: { select: { turnId: true } },
          _count: { select: { awards: true } },
        },
      });
      for (const turn of openTurns) {
        const last = await tx.drawingOperation.aggregate({
          where: { turnId: turn.id },
          _max: { canvasSeq: true },
        });
        if (!turn.finalization) {
          const points = turn.status === 'DRAWING' ? drawerPoints(turn._count.awards) : 0;
          await tx.turnFinalization.create({ data: { turnId: turn.id, drawerPoints: points, finalizedAt: now } });
          await tx.gamePlayer.update({ where: { id: turn.drawerId }, data: { score: { increment: points } } });
        }
        await tx.turn.update({
          where: { id: turn.id },
          data: {
            status: 'ENDED',
            endReason: 'SERVER_RESTART',
            endedAt: now,
            finalCanvasSeq: last._max.canvasSeq ?? 0,
          },
        });
      }
      const games = await tx.game.updateMany({
        where: { status: 'IN_PROGRESS' },
        data: { status: 'INTERRUPTED', endedAt: now },
      });
      // Rooms nobody returns to get closed by the idle cleanup.
      await tx.room.updateMany({
        where: { status: 'OPEN', idleExpiresAt: null },
        data: { idleExpiresAt: new Date(now.getTime() + roomIdleMs) },
      });
      return { turns: openTurns.length, games: games.count };
    },
    { timeout: 60_000 },
  );
  if (result.turns > 0 || result.games > 0) {
    logger.info(result, 'closed turns and games interrupted by the previous shutdown');
  }
  return result;
}

/** Retention: idle rooms close; finished games, closed rooms and expired sessions are deleted later. */
export async function runRetentionCleanup(
  prisma: PrismaClient,
  retentionMs: number,
  loadedRoomIds: readonly string[],
): Promise<Record<string, number>> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionMs);
  const closed = await prisma.room.updateMany({
    where: { status: 'OPEN', idleExpiresAt: { lt: now }, id: { notIn: [...loadedRoomIds] } },
    data: { status: 'CLOSED' },
  });
  const games = await prisma.game.deleteMany({
    where: { status: { in: ['FINISHED', 'INTERRUPTED'] }, endedAt: { lt: cutoff } },
  });
  const rooms = await prisma.room.deleteMany({ where: { status: 'CLOSED', idleExpiresAt: { lt: cutoff } } });
  const sessions = await prisma.guestSession.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return { roomsClosed: closed.count, gamesDeleted: games.count, roomsDeleted: rooms.count, sessionsDeleted: sessions.count };
}
