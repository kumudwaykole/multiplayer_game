export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  CSRF_FAILED: 403,
  ORIGIN_REJECTED: 403,
  FORBIDDEN: 403,
  NOT_MEMBER: 403,
  NOT_HOST: 403,
  NOT_DRAWER: 403,
  NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  ROOM_CLOSED: 410,
  ROOM_FULL: 409,
  WRONG_PHASE: 409,
  STALE_TURN: 409,
  TURN_CLOSED: 409,
  NOT_ENOUGH_PLAYERS: 409,
  SETTINGS_CONFLICT: 409,
  CHAT_LOCKED: 409,
  INVALID_OPERATION: 422,
  TURN_BUDGET_EXCEEDED: 422,
  RATE_LIMITED: 429,
  BUSY: 503,
  CAPACITY: 503,
  SERVER_DRAINING: 503,
  UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** An expected, client-visible failure. Messages must never contain secrets such as the active word. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message?: string, retryAfterMs?: number) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
