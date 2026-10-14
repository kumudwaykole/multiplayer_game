import { parse as parseCookie } from 'cookie';
import type { CookieOptions, Response } from 'express';
import { hashToken, randomToken } from '../lib/ids.js';
import type { PrismaClient } from '../persistence/prisma.js';

export const SESSION_COOKIE = 'dg_sid';
export const CSRF_COOKIE = 'dg_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface GuestSession {
  id: string;
  displayName: string;
  expiresAt: Date;
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

  async create(displayName: string): Promise<{ token: string; session: GuestSession }> {
    const token = randomToken();
    const session = await this.prisma.guestSession.create({
      data: { tokenHash: hashToken(token), displayName, expiresAt: new Date(Date.now() + this.ttlMs) },
      select: { id: true, displayName: true, expiresAt: true },
    });
    return { token, session };
  }

  async findByToken(token: string | undefined): Promise<GuestSession | null> {
    if (!token || token.length > 128) return null;
    const session = await this.prisma.guestSession.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, displayName: true, expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    return session;
  }

  async rename(sessionId: string, displayName: string): Promise<GuestSession> {
    return this.prisma.guestSession.update({
      where: { id: sessionId },
      data: { displayName },
      select: { id: true, displayName: true, expiresAt: true },
    });
  }

  /** Returns a new token when the session was rotated, otherwise null. */
  async rotateIfAging(session: GuestSession): Promise<{ token: string; session: GuestSession } | null> {
    if (session.expiresAt.getTime() - Date.now() > this.ttlMs / 2) return null;
    const token = randomToken();
    const updated = await this.prisma.guestSession.update({
      where: { id: session.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + this.ttlMs) },
      select: { id: true, displayName: true, expiresAt: true },
    });
    return { token, session: updated };
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
