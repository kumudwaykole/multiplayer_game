import { pino } from 'pino';
import { io, type Socket } from 'socket.io-client';
import { inject } from 'vitest';
import { loadConfig, type Config } from '../../src/config/env.js';
import { startServer, type RunningServer } from '../../src/server.js';

export const ORIGIN = 'http://localhost:5173';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: inject('databaseUrl'),
    PUBLIC_ORIGIN: ORIGIN,
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'silent',
    DB_POOL_SIZE: '5',
    DRAW_BATCH_MS: '5',
    IP_RATE_LIMIT_SCALE: '100',
    ...overrides,
  });
}

export async function startTestServer(overrides?: Record<string, string>): Promise<RunningServer> {
  return startServer(testConfig(overrides), pino({ level: 'silent' }));
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

/** One browser: a cookie jar, the CSRF token and a socket. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  socket: Socket | null = null;
  readonly events: Array<{ event: string; payload: any }> = [];
  private commandSeq = 0;

  constructor(
    readonly baseUrl: string,
    readonly origin = ORIGIN,
  ) {}

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        origin: this.origin,
        cookie: this.cookieHeader,
        'x-csrf-token': this.cookies.get('dg_csrf') ?? '',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async signIn(name: string): Promise<void> {
    await this.request('GET', '/api/session');
    const res = await this.request('POST', '/api/session', { displayName: name });
    if (res.status !== 201 && res.status !== 200) throw new Error(`sign in failed: ${JSON.stringify(res.body)}`);
  }

  async createRoom(): Promise<{ code: string; playerId: string }> {
    const res = await this.request('POST', '/api/rooms');
    if (res.status !== 201) throw new Error(`create room failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async join(code: string): Promise<{ playerId: string }> {
    const res = await this.request('POST', `/api/rooms/${code}/join`);
    if (res.status !== 200) throw new Error(`join failed: ${JSON.stringify(res.body)}`);
    return res.body;
  }

  connect(options: { origin?: string; withCookies?: boolean } = {}): Promise<Socket> {
    const socket = io(this.baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: {
        origin: options.origin ?? this.origin,
        ...(options.withCookies === false ? {} : { cookie: this.cookieHeader }),
      },
    });
    socket.onAny((event: string, payload: unknown) => this.events.push({ event, payload }));
    this.socket = socket;
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', (err) => reject(err));
    });
  }

  async send(event: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!this.socket) throw new Error('not connected');
    return this.socket.timeout(5_000).emitWithAck(event, { commandId: `cmd${++this.commandSeq}`, ...payload });
  }

  async subscribe(code: string): Promise<any> {
    const ack = await this.send('room:subscribe', { code });
    if (!ack.ok) throw new Error(`subscribe failed: ${JSON.stringify(ack)}`);
    return this.last('room:snapshot');
  }

  last(event: string): any {
    return this.events.filter((e) => e.event === event).at(-1)?.payload;
  }

  all(event: string): any[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload);
  }

  /** Resolves with the first matching event (already received or upcoming). */
  waitFor(event: string, predicate: (payload: any) => boolean = () => true, timeoutMs = 5_000): Promise<any> {
    const existing = this.events.find((e) => e.event === event && predicate(e.payload));
    if (existing) return Promise.resolve(existing.payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.offAny(listener);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const listener = (name: string, payload: unknown) => {
        if (name === event && predicate(payload)) {
          clearTimeout(timer);
          this.socket?.offAny(listener);
          resolve(payload);
        }
      };
      this.socket?.onAny(listener);
    });
  }

  close(): void {
    this.socket?.disconnect();
  }
}

export async function signedInClients(server: RunningServer, names: string[]): Promise<TestClient[]> {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const clients = names.map(() => new TestClient(baseUrl));
  await Promise.all(clients.map((client, i) => client.signIn(names[i]!)));
  return clients;
}
