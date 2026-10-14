import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const int = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: int(0, 65_535, 3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgresql:// URL'),
  DB_POOL_SIZE: int(1, 100, 10),
  PUBLIC_ORIGIN: z.url(),
  /** Extra origins allowed for sockets and mutating requests, comma separated (e.g. a LAN address). */
  ALLOWED_ORIGINS: z.string().default(''),
  COOKIE_SECURE: booleanString.optional(),
  /** Express "trust proxy": false, true, a hop count, or a list of addresses. */
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MIN_PLAYERS_TO_START: int(2, 12, 3),
  MAX_ROOMS: int(1, 100_000, 1000),
  MAX_CONNECTIONS: int(1, 1_000_000, 10_000),
  RECONNECT_GRACE_SECONDS: int(5, 600, 30),
  ROOM_IDLE_MINUTES: int(1, 1440, 30),
  SESSION_TTL_DAYS: int(1, 90, 7),
  RETENTION_DAYS: int(1, 365, 7),
  DRAW_BATCH_MS: int(0, 20, 10),
  ROOM_QUEUE_DEPTH: int(10, 100_000, 2000),
  /** Multiplies per-IP HTTP limits. Only for load tests that run many clients from one machine. */
  IP_RATE_LIMIT_SCALE: int(1, 100_000, 1),
  METRICS_TOKEN: z.string().min(16).optional(),
  SHUTDOWN_TIMEOUT_MS: int(1000, 120_000, 30_000),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolSize: number;
  publicOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  cookieSecure: boolean;
  trustProxy: boolean | number | string;
  logLevel: string;
  minPlayers: number;
  maxRooms: number;
  maxConnections: number;
  graceMs: number;
  roomIdleMs: number;
  sessionTtlMs: number;
  retentionMs: number;
  drawBatchMs: number;
  roomQueueDepth: number;
  ipRateLimitScale: number;
  metricsToken: string | undefined;
  shutdownTimeoutMs: number;
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'false' || value === '') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and problems only, never the values.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`);
  }
  const e = parsed.data;
  const publicOrigin = new URL(e.PUBLIC_ORIGIN).origin;
  const extra = e.ALLOWED_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const DAY = 24 * 60 * 60 * 1000;
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbPoolSize: e.DB_POOL_SIZE,
    publicOrigin,
    allowedOrigins: new Set([publicOrigin, ...extra]),
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: e.LOG_LEVEL,
    minPlayers: e.MIN_PLAYERS_TO_START,
    maxRooms: e.MAX_ROOMS,
    maxConnections: e.MAX_CONNECTIONS,
    graceMs: e.RECONNECT_GRACE_SECONDS * 1000,
    roomIdleMs: e.ROOM_IDLE_MINUTES * 60 * 1000,
    sessionTtlMs: e.SESSION_TTL_DAYS * DAY,
    retentionMs: e.RETENTION_DAYS * DAY,
    drawBatchMs: e.DRAW_BATCH_MS,
    roomQueueDepth: e.ROOM_QUEUE_DEPTH,
    ipRateLimitScale: e.IP_RATE_LIMIT_SCALE,
    metricsToken: e.METRICS_TOKEN,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}
