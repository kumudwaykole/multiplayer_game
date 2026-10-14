import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { setSessionCookie, type GuestSession, type SessionService } from '../auth/sessions.js';
import type { Config } from '../config/env.js';
import type { RoomManager } from '../game/roomManager.js';
import { DEFAULT_SETTINGS, settingsInputSchema, validateSettings } from '../game/settings.js';
import { cleanName } from '../game/text.js';
import { AppError } from '../lib/errors.js';
import { ROOM_CODE_PATTERN, roomCode } from '../lib/ids.js';
import { KeyedRateLimiter } from '../lib/rateLimit.js';
import type { Metrics } from '../observability/metrics.js';
import { isUniqueViolation, type Prisma, type PrismaClient } from '../persistence/prisma.js';
import { clientKey, rateLimit, requireSession } from './middleware.js';
import { replayIndex, replayPage } from './replays.js';

export interface RouteDeps {
  config: Config;
  prisma: PrismaClient;
  sessions: SessionService;
  rooms: RoomManager;
  metrics: Metrics;
  isDraining: () => boolean;
  readiness: () => Promise<{ ready: boolean; checks: Record<string, boolean> }>;
}

const HOUR = 3600;

export function createRouter(deps: RouteDeps): Router {
  const { config, prisma, sessions, rooms } = deps;
  const router = Router();

  const ipScale = config.ipRateLimitScale;
  const perIp = (capacity: number, refillPerSec: number) =>
    new KeyedRateLimiter({ capacity: capacity * ipScale, refillPerSec: refillPerSec * ipScale });
  const limits = {
    // Keyed by session when there is one, otherwise by IP.
    general: new KeyedRateLimiter({ capacity: 120, refillPerSec: 2 }),
    sessionIp: perIp(5, 10 / 60),
    roomSession: new KeyedRateLimiter({ capacity: 5, refillPerSec: 5 / HOUR }),
    roomIp: perIp(20, 20 / HOUR),
    joinSession: new KeyedRateLimiter({ capacity: 30, refillPerSec: 0.5 }),
    joinIp: perIp(30, 0.5),
  };
  const sweeper = setInterval(() => Object.values(limits).forEach((l) => l.sweep()), 60_000);
  sweeper.unref();

  const sessionOrIp = (req: Request, res: Response) => res.locals.session?.id ?? `ip:${clientKey(req)}`;
  const bySession = (_req: Request, res: Response) => requireSession(res).id;

  // ---------------------------------------------------------------- health
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health/ready', async (_req, res) => {
    const { ready, checks } = await deps.readiness();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
  });

  router.get('/metrics', (req, res) => {
    if (!config.metricsToken) throw new AppError('NOT_FOUND', 'Not found');
    if (req.header('authorization') !== `Bearer ${config.metricsToken}`) throw new AppError('FORBIDDEN', 'Forbidden');
    res.json(deps.metrics.snapshot(rooms.stats()));
  });

  router.use(rateLimit(limits.general, sessionOrIp));

  // --------------------------------------------------------------- session
  router.get('/session', (_req, res) => {
    const session = res.locals.session;
    res.json({ session: session ? publicSession(session) : null, csrfToken: res.locals.csrfToken });
  });

  const avatarPart = z.number().int().min(0).max(63);
  const sessionBody = z.strictObject({
    displayName: z.string().max(100),
    avatar: z.tuple([avatarPart, avatarPart, avatarPart]).optional(),
  });

  router.post('/session', rateLimit(limits.sessionIp, (req) => clientKey(req)), async (req, res) => {
    const { displayName, avatar } = sessionBody.parse(req.body);
    const name = cleanName(displayName);
    if (!name) throw new AppError('BAD_REQUEST', 'Names must be 1-24 characters of plain text');
    const existing = res.locals.session;
    if (existing) {
      const updated = await sessions.update(existing.id, name, avatar ?? existing.avatar);
      res.json({ session: publicSession(updated), csrfToken: res.locals.csrfToken });
      return;
    }
    const { token, session } = await sessions.create(name, avatar ?? [0, 0, 0]);
    setSessionCookie(res, token, config.cookieSecure, session.expiresAt);
    deps.metrics.inc('sessions_created');
    res.status(201).json({ session: publicSession(session), csrfToken: res.locals.csrfToken });
  });

  // ----------------------------------------------------------------- rooms
  router.post(
    '/rooms',
    rateLimit(limits.roomSession, bySession),
    rateLimit(limits.roomIp, (req) => clientKey(req)),
    async (_req, res) => {
      const session = requireSession(res);
      if (deps.isDraining()) throw new AppError('SERVER_DRAINING', 'Server is restarting, try again shortly');
      if (rooms.size >= config.maxRooms) throw new AppError('CAPACITY', 'The server is full right now');
      const code = await createRoomRecord(prisma, session.id);
      const room = await rooms.get(code);
      if (!room) throw new AppError('INTERNAL', 'Room could not be opened');
      const { playerId } = await room.join(session.id, session.displayName, session.avatar);
      deps.metrics.inc('rooms_created');
      res.status(201).json({
        code,
        invitePath: `/room/${code}`,
        inviteUrl: `${config.publicOrigin}/room/${code}`,
        playerId,
      });
    },
  );

  router.post(
    '/rooms/:code/join',
    rateLimit(limits.joinSession, bySession),
    rateLimit(limits.joinIp, (req) => clientKey(req)),
    async (req, res) => {
      const session = requireSession(res);
      if (deps.isDraining()) throw new AppError('SERVER_DRAINING', 'Server is restarting, try again shortly');
      const room = await requireRoom(rooms, req.params.code);
      const { playerId } = await room.join(session.id, session.displayName, session.avatar);
      res.json({ playerId, state: room.summaryFor(session.id)?.state ?? null });
    },
  );

  router.get('/rooms/:code', async (req, res) => {
    const session = requireSession(res);
    const room = await requireRoom(rooms, req.params.code);
    const summary = room.summaryFor(session.id);
    if (!summary) throw new AppError('NOT_MEMBER', 'Join the room first');
    res.json(summary);
  });

  router.get('/rooms/:code/settings', async (req, res) => {
    const session = requireSession(res);
    const room = await requireRoom(rooms, req.params.code);
    res.json(room.hostSettingsFor(session.id));
  });

  const settingsBody = z.strictObject({ version: z.number().int().min(0), settings: settingsInputSchema });

  router.put('/rooms/:code/settings', async (req, res) => {
    const session = requireSession(res);
    const room = await requireRoom(rooms, req.params.code);
    const body = settingsBody.parse(req.body);
    const validated = validateSettings(body.settings);
    if (!validated.ok) throw new AppError('BAD_REQUEST', validated.message);
    res.json(await room.updateSettings(session.id, body.version, validated.settings));
  });

  // --------------------------------------------------------------- replays
  router.get('/games/:id/replays', async (req, res) => {
    const session = requireSession(res);
    const gameId = z.uuid().safeParse(req.params.id);
    if (!gameId.success) throw new AppError('NOT_FOUND', 'Replay not found');
    res.json(await replayIndex(prisma, gameId.data, session.id));
  });

  const replayQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });

  router.get('/turns/:id/replay', async (req, res) => {
    const session = requireSession(res);
    const turnId = z.uuid().safeParse(req.params.id);
    if (!turnId.success) throw new AppError('NOT_FOUND', 'Replay not found');
    const { afterSeq } = replayQuery.parse(req.query);
    res.json(await replayPage(prisma, turnId.data, session.id, afterSeq));
  });

  return router;
}

function publicSession(session: GuestSession) {
  return { name: session.displayName, avatar: session.avatar };
}

async function requireRoom(rooms: RoomManager, code: string | string[] | undefined) {
  if (typeof code !== 'string' || !ROOM_CODE_PATTERN.test(code)) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
  const room = await rooms.get(code);
  if (!room) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
  return room;
}

/** Creates the room with the creator as host member, retrying on the (astronomically unlikely) code clash. */
async function createRoomRecord(prisma: PrismaClient, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = roomCode();
    try {
      await prisma.$transaction(async (tx) => {
        const room = await tx.room.create({
          data: { code, settings: DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue },
          select: { id: true },
        });
        const membership = await tx.membership.create({ data: { roomId: room.id, sessionId }, select: { id: true } });
        await tx.room.update({ where: { id: room.id }, data: { hostMembershipId: membership.id } });
      });
      return code;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError('INTERNAL', 'Could not allocate a room code');
}
