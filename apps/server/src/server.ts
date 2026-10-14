import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Server as SocketServer } from 'socket.io';
import { createApp } from './app.js';
import { SessionService } from './auth/sessions.js';
import type { Config } from './config/env.js';
import { RoomManager } from './game/roomManager.js';
import { systemClock } from './lib/clock.js';
import { Metrics } from './observability/metrics.js';
import { DrawingWriter } from './persistence/drawingWriter.js';
import { PrismaGameRepository } from './persistence/gameRepository.js';
import { migrationsApplied, reconcileAfterRestart, runRetentionCleanup } from './persistence/maintenance.js';
import { createPrisma, type PrismaClient } from './persistence/prisma.js';
import { ServerEvents } from './realtime/protocol.js';
import { createSocketServer } from './realtime/socketServer.js';
import { SocketIoTransport } from './realtime/transport.js';

export interface RunningServer {
  httpServer: HttpServer;
  io: SocketServer;
  prisma: PrismaClient;
  rooms: RoomManager;
  metrics: Metrics;
  /** Actual port (useful when configured as 0 in tests). */
  port: number;
  stop(reason?: string): Promise<void>;
  /** Abrupt stop with no shutdown work, like a crash. For tests. */
  kill(): Promise<void>;
}

const HEARTBEAT_MS = 5_000;
const CLEANUP_MS = 10 * 60_000;

export async function startServer(config: Config, logger: Logger): Promise<RunningServer> {
  const prisma = createPrisma(config.databaseUrl, config.dbPoolSize);
  const metrics = new Metrics();
  const migrationsDir = path.resolve(process.cwd(), 'prisma/migrations');

  await waitForDatabase(prisma, logger);
  let migrationsOk = await migrationsApplied(prisma, migrationsDir);
  if (!migrationsOk) {
    throw new Error('Database migrations are not applied. Run `pnpm db:deploy` (or `pnpm db:dev` in development).');
  }
  await reconcileAfterRestart(prisma, config.roomIdleMs, logger);

  const repo = new PrismaGameRepository(prisma);
  const writer = new DrawingWriter(repo, { batchMs: config.drawBatchMs, maxPending: 50_000 }, logger, metrics);
  const rooms = new RoomManager({
    repo,
    writer,
    clock: systemClock,
    logger,
    metrics,
    config: {
      minPlayers: config.minPlayers,
      graceMs: config.graceMs,
      idleMs: config.roomIdleMs,
      maxQueueDepth: config.roomQueueDepth,
    },
  });
  const sessions = new SessionService(prisma, config.sessionTtlMs);

  let draining = false;
  const isDraining = () => draining;

  const readiness = async () => {
    const database = await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    );
    if (database && !migrationsOk) migrationsOk = await migrationsApplied(prisma, migrationsDir);
    const checks = { database, migrations: migrationsOk, accepting: !draining };
    return { ready: database && migrationsOk && !draining, checks };
  };

  const app = createApp({ config, prisma, sessions, rooms, metrics, logger, isDraining, readiness });
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer, { config, sessions, rooms, logger, metrics, isDraining });
  rooms.attachTransport(new SocketIoTransport(io));

  const heartbeat = setInterval(() => {
    rooms.heartbeat().catch((err: unknown) => logger.warn({ err }, 'recovery heartbeat failed'));
  }, HEARTBEAT_MS);
  const cleanup = setInterval(() => {
    runRetentionCleanup(prisma, config.retentionMs, rooms.loadedRoomIds())
      .then((result) => logger.info(result, 'retention cleanup'))
      .catch((err: unknown) => logger.warn({ err }, 'retention cleanup failed'));
  }, CLEANUP_MS);
  heartbeat.unref();
  cleanup.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  logger.info({ port, origin: config.publicOrigin }, 'server listening');

  let stopping: Promise<void> | null = null;
  const stop = (reason = 'shutdown') => {
    stopping ??= (async () => {
      logger.info({ reason }, 'draining');
      draining = true;
      io.emit(ServerEvents.draining, { reconnectAfterMs: 3_000 });
      clearInterval(heartbeat);
      clearInterval(cleanup);
      await rooms.shutdown();
      await writer.drain();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      metrics.stop();
      await prisma.$disconnect();
      logger.info('stopped');
    })();
    return stopping;
  };

  const kill = async () => {
    clearInterval(heartbeat);
    clearInterval(cleanup);
    rooms.dispose();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    httpServer.closeAllConnections?.();
    await writer.drain().catch(() => undefined);
    metrics.stop();
    await prisma.$disconnect();
  };

  return { httpServer, io, prisma, rooms, metrics, port, stop, kill };
}

async function waitForDatabase(prisma: PrismaClient, logger: Logger): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      logger.warn({ attempt }, 'database not reachable yet, retrying');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
