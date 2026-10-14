import type { Server as HttpServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import type { z } from 'zod';
import { readCookie, SESSION_COOKIE, type SessionService } from '../auth/sessions.js';
import type { Config } from '../config/env.js';
import { isHeavyOperation, operationBytes } from '../drawing/operations.js';
import type { RoomRuntime } from '../game/room.js';
import type { RoomManager } from '../game/roomManager.js';
import { cleanChat } from '../game/text.js';
import { AppError, isAppError } from '../lib/errors.js';
import { TokenBucket, takeAll } from '../lib/rateLimit.js';
import type { Metrics } from '../observability/metrics.js';
import {
  ClientEvents,
  chatCommandSchema,
  drawCommandSchema,
  selectWordSchema,
  simpleCommandSchema,
  subscribeSchema,
  timeSyncSchema,
  type Ack,
} from './protocol.js';

export interface SocketServerDeps {
  config: Config;
  sessions: SessionService;
  rooms: RoomManager;
  logger: Logger;
  metrics: Metrics;
  isDraining: () => boolean;
}

interface SocketLimits {
  any: TokenBucket;
  control: TokenBucket;
  chatBurst: TokenBucket;
  chatMinute: TokenBucket;
  drawOps: TokenBucket;
  drawBytes: TokenBucket;
  drawHeavy: TokenBucket;
  sync: TokenBucket;
}

interface SocketState {
  sessionId: string;
  room: RoomRuntime | null;
  memberId: string | null;
  limits: SocketLimits;
  violations: number[];
}

export const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024;
const VIOLATION_WINDOW_MS = 10_000;
const MAX_VIOLATIONS = 40;

function createLimits(): SocketLimits {
  return {
    any: new TokenBucket(200, 100),
    control: new TokenBucket(10, 2),
    chatBurst: new TokenBucket(5, 2),
    chatMinute: new TokenBucket(60, 1),
    drawOps: new TokenBucket(90, 60),
    drawBytes: new TokenBucket(64 * 1024, 64 * 1024),
    drawHeavy: new TokenBucket(6, 4),
    sync: new TokenBucket(5, 2),
  };
}

function limit(buckets: TokenBucket[], cost = 1): void {
  const result = takeAll(buckets, cost);
  if (!result.ok) throw new AppError('RATE_LIMITED', 'Slow down', result.retryAfterMs);
}

function commandIdOf(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'commandId' in raw) {
    const value = (raw as { commandId: unknown }).commandId;
    if (typeof value === 'string' && value.length <= 64) return value;
  }
  return null;
}

export function createSocketServer(httpServer: HttpServer, deps: SocketServerDeps): Server {
  const { config, sessions, rooms, logger, metrics } = deps;

  const io: Server = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
    pingInterval: 10_000,
    pingTimeout: 5_000,
    // Same-origin by default; the Origin allowlist is enforced here rather than via CORS.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin || !config.allowedOrigins.has(origin)) {
        metrics.inc('socket_rejected_origin');
        return callback('ORIGIN_REJECTED', false);
      }
      if (deps.isDraining()) return callback('SERVER_DRAINING', false);
      if (io.engine.clientsCount >= config.maxConnections) {
        metrics.inc('socket_rejected_capacity');
        return callback('CAPACITY', false);
      }
      callback(null, true);
    },
  });

  const states = new WeakMap<Socket, SocketState>();

  io.use((socket, next) => {
    const token = readCookie(socket.request.headers.cookie, SESSION_COOKIE);
    sessions
      .findByToken(token)
      .then((session) => {
        if (!session) return next(new Error('UNAUTHENTICATED'));
        states.set(socket, {
          sessionId: session.id,
          room: null,
          memberId: null,
          limits: createLimits(),
          violations: [],
        });
        next();
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'socket session lookup failed');
        next(new Error('UNAVAILABLE'));
      });
  });

  io.on('connection', (socket) => {
    const state = states.get(socket)!;
    metrics.inc('socket_connections');

    const recordViolation = () => {
      const now = performance.now();
      state.violations.push(now);
      while (state.violations.length > 0 && now - state.violations[0]! > VIOLATION_WINDOW_MS) state.violations.shift();
      if (state.violations.length > MAX_VIOLATIONS) {
        metrics.inc('socket_kicked_abuse');
        logger.warn({ room: state.room?.code }, 'disconnecting socket after repeated violations');
        socket.disconnect(true);
      }
    };

    const requireRoom = (): { room: RoomRuntime; memberId: string } => {
      if (!state.room || !state.memberId) throw new AppError('NOT_MEMBER', 'Subscribe to a room first');
      return { room: state.room, memberId: state.memberId };
    };

    function handle<S extends z.ZodType>(
      event: string,
      schema: S,
      handler: (input: z.infer<S>, receivedMono: number) => Promise<Partial<Ack>> | Partial<Ack>,
    ): void {
      socket.on(event, (raw: unknown, ack?: unknown) => {
        // Ingress time on the monotonic clock: this is what deadlines and scoring use.
        const receivedMono = performance.now();
        const reply = typeof ack === 'function' ? (ack as (body: Ack) => void) : () => undefined;
        const commandId = commandIdOf(raw);
        const fail = (err: unknown) => {
          if (isAppError(err)) {
            if (err.code === 'RATE_LIMITED' || err.code === 'BAD_REQUEST' || err.code === 'PAYLOAD_TOO_LARGE') {
              recordViolation();
            }
            metrics.inc(`socket_rejected_${err.code}`);
            reply({ commandId, ok: false, code: err.code, message: err.message, ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) });
            return;
          }
          logger.error({ err, event, room: state.room?.code }, 'socket handler failed');
          reply({ commandId, ok: false, code: 'INTERNAL', message: 'Something went wrong' });
        };
        try {
          limit([state.limits.any]);
          const parsed = schema.safeParse(raw);
          if (!parsed.success) throw new AppError('BAD_REQUEST', 'Invalid message');
          Promise.resolve(handler(parsed.data, receivedMono)).then(
            (result) => reply({ commandId, ok: true, ...result }),
            fail,
          );
        } catch (err) {
          fail(err);
        }
      });
    }

    handle(ClientEvents.subscribe, subscribeSchema, async (input) => {
      limit([state.limits.control]);
      const room = await rooms.get(input.code);
      if (!room) throw new AppError('ROOM_NOT_FOUND', 'Room not found');
      if (state.room && state.room !== room && state.memberId) {
        const previous = state.room;
        void socket.leave(previous.channel);
        await previous.disconnect(state.memberId, socket.id);
      }
      const { playerId } = await room.subscribe(state.sessionId, socket.id, {
        turnId: input.turnId,
        canvasSeq: input.canvasSeq,
      });
      state.room = room;
      state.memberId = playerId;
      return {};
    });

    handle(ClientEvents.leave, simpleCommandSchema, async () => {
      limit([state.limits.control]);
      const { room, memberId } = requireRoom();
      await room.leave(memberId, socket.id);
      state.room = null;
      state.memberId = null;
      return {};
    });

    handle(ClientEvents.startGame, simpleCommandSchema, async () => {
      limit([state.limits.control]);
      const { room, memberId } = requireRoom();
      await room.startGame(memberId, socket.id);
      return {};
    });

    handle(ClientEvents.returnToLobby, simpleCommandSchema, async () => {
      limit([state.limits.control]);
      const { room, memberId } = requireRoom();
      await room.returnToLobby(memberId, socket.id);
      return {};
    });

    handle(ClientEvents.selectWord, selectWordSchema, async (input) => {
      limit([state.limits.control]);
      const { room, memberId } = requireRoom();
      await room.selectWord(memberId, socket.id, input.turnId, input.candidateId);
      return {};
    });

    handle(ClientEvents.draw, drawCommandSchema, async (input, receivedMono) => {
      const { room, memberId } = requireRoom();
      const op = input.op;
      // Ending a stroke is never rate limited, so limits cannot leave a stroke stuck open.
      if (op.type !== 'stroke.end') {
        limit([state.limits.drawOps]);
        if (isHeavyOperation(op)) limit([state.limits.drawHeavy]);
        limit([state.limits.drawBytes], operationBytes(op));
      }
      const result = await room.draw(memberId, socket.id, input.commandId, input.turnId, op, receivedMono);
      return { canvasSeq: result.canvasSeq, actionId: result.actionId };
    });

    handle(ClientEvents.chat, chatCommandSchema, async (input, receivedMono) => {
      limit([state.limits.chatBurst, state.limits.chatMinute]);
      const { room, memberId } = requireRoom();
      const text = cleanChat(input.text);
      if (!text) throw new AppError('BAD_REQUEST', 'Messages must be 1-200 characters of plain text');
      const outcome = await room.chat(memberId, socket.id, input.commandId, text, receivedMono);
      return outcome.result ? { result: outcome.result } : {};
    });

    handle(ClientEvents.timeSync, timeSyncSchema, () => {
      limit([state.limits.sync]);
      return { serverNow: Date.now() };
    });

    socket.on('disconnect', () => {
      metrics.inc('socket_disconnects');
      const { room, memberId } = state;
      if (room && memberId) {
        room.disconnect(memberId, socket.id).catch((err: unknown) => {
          logger.error({ err, room: room.code }, 'disconnect handling failed');
        });
      }
    });
  });

  return io;
}
