import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  readCookie,
  SESSION_COOKIE,
  setCsrfCookie,
  setSessionCookie,
  type GuestSession,
  type SessionService,
} from '../auth/sessions.js';
import type { Config } from '../config/env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { randomToken, safeEqual } from '../lib/ids.js';
import type { KeyedRateLimiter } from '../lib/rateLimit.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      requestId: string;
      session: GuestSession | null;
      csrfToken: string;
    }
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

export function loadSession(sessions: SessionService, config: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    let session = await sessions.findByToken(token);
    if (session) {
      const rotated = await sessions.rotateIfAging(session);
      if (rotated) {
        session = rotated.session;
        setSessionCookie(res, rotated.token, config.cookieSecure, rotated.session.expiresAt);
      }
    }
    res.locals.session = session;
    next();
  };
}

export function requireSession(res: Response): GuestSession {
  const session = res.locals.session;
  if (!session) throw new AppError('UNAUTHENTICATED', 'Create a session first');
  return session;
}

/**
 * Double-submit CSRF protection plus an Origin allowlist for every mutating
 * request. Cookie authentication alone is not trusted.
 */
export function csrfAndOrigin(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let token = readCookie(req.headers.cookie, CSRF_COOKIE);
    if (!token || token.length > 128) {
      token = randomToken(24);
      setCsrfCookie(res, token, config.cookieSecure);
    }
    res.locals.csrfToken = token;
    if (!UNSAFE_METHODS.has(req.method)) return next();

    const origin = req.header('origin');
    if (origin ? !config.allowedOrigins.has(origin) : req.header('sec-fetch-site') === 'cross-site') {
      throw new AppError('ORIGIN_REJECTED', 'Request origin not allowed');
    }
    const header = req.header(CSRF_HEADER);
    const cookie = readCookie(req.headers.cookie, CSRF_COOKIE);
    if (!header || !cookie || !safeEqual(header, cookie)) {
      throw new AppError('CSRF_FAILED', 'Missing or invalid CSRF token');
    }
    next();
  };
}

export function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(limiter: KeyedRateLimiter, key: (req: Request, res: Response) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = limiter.take(key(req, res));
    if (!result.ok) {
      res.setHeader('retry-after', Math.ceil(result.retryAfterMs / 1000));
      throw new AppError('RATE_LIMITED', 'Too many requests', result.retryAfterMs);
    }
    next();
  };
}

export function notFound(): never {
  throw new AppError('NOT_FOUND', 'Not found');
}

export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = res.locals.requestId;
    if (isAppError(err)) {
      res.status(err.status).json({
        code: err.code,
        message: err.message,
        requestId,
        ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}),
      });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'Invalid request', requestId });
      return;
    }
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId });
      return;
    }
    if (type === 'entity.parse.failed' || type === 'encoding.unsupported') {
      res.status(400).json({ code: 'BAD_REQUEST', message: 'Malformed JSON', requestId });
      return;
    }
    logger.error({ err, requestId, path: req.path }, 'unhandled request error');
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong', requestId });
  };
}
