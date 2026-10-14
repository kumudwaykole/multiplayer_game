import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Room invitation code: 12 random bytes (96 bits) as 16 base64url characters. */
export function roomCode(): string {
  return randomBytes(12).toString('base64url');
}

export const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
