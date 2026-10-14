import { parse as parseCookie } from 'cookie';
import type { CookieOptions, Response } from 'express';
import { hashToken, randomToken } from '../lib/ids.js';
import type { PrismaClient } from '../persistence/prisma.js';

export const SESSION_COOKIE = 'dg_sid';
export const CSRF_COOKIE = 'dg_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export type Avatar = [number, number, number];

export interface GuestSession {
  id: string;
  displayName: string;
  avatar: Avatar;
  expiresAt: Date;
}

const SELECT = { id: true, displayName: true, avatar: true, expiresAt: true } as const;

function toSession(row: { id: string; displayName: string; avatar: number[]; expiresAt: Date }): GuestSession {
  const [a = 0, b = 0, c = 0] = row.avatar;
  return { id: row.id, displayName: row.displayName, avatar: [a, b, c], expiresAt: row.expiresAt };
}

/**
 * Guest sessions: an opaque random token in an HttpOnly cookie, stored only
 * as a SHA-256 hash. Expiry slides forward with use; when less than half the
 * lifetime remains the token is rotated.
 */
export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs: number,
  ) {}

  async create(displayName: string, avatar: Avatar): Promise<{ token: string; session: GuestSession }> {
    const token = randomToken();
    const row = await this.prisma.guestSession.create({
      data: { tokenHash: hashToken(token), displayName, avatar, expiresAt: new Date(Date.now() + this.ttlMs) },
      select: SELECT,
    });
    return { token, session: toSession(row) };
  }

  async findByToken(token: string | undefined): Promise<GuestSession | null> {
    if (!token || token.length > 128) return null;
    const row = await this.prisma.guestSession.findUnique({ where: { tokenHash: hashToken(token) }, select: SELECT });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return toSession(row);
  }

  async update(sessionId: string, displayName: string, avatar: Avatar): Promise<GuestSession> {
    const row = await this.prisma.guestSession.update({
      where: { id: sessionId },
      data: { displayName, avatar },
      select: SELECT,
    });
    return toSession(row);
  }

  /** Returns a new token when the session was rotated, otherwise null. */
  async rotateIfAging(session: GuestSession): Promise<{ token: string; session: GuestSession } | null> {
    if (session.expiresAt.getTime() - Date.now() > this.ttlMs / 2) return null;
    const token = randomToken();
    const row = await this.prisma.guestSession.update({
      where: { id: session.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + this.ttlMs) },
      select: SELECT,
    });
    return { token, session: toSession(row) };
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  return parseCookie(header)[name];
}

export function sessionCookieOptions(secure: boolean, expires: Date): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/', expires };
}

export function setSessionCookie(res: Response, token: string, secure: boolean, expires: Date): void {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(secure, expires));
}

/** The CSRF cookie is readable by the page (double-submit pattern), never HttpOnly. */
export function setCsrfCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure, sameSite: 'lax', path: '/' });
}
