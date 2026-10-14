import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../src/server.js';
import { TestClient, signedInClients, startTestServer } from './support.js';

let server: RunningServer;
let baseUrl: string;

beforeAll(async () => {
  server = await startTestServer();
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop('test');
});

describe('health', () => {
  it('reports live and ready once migrations are applied', async () => {
    const client = new TestClient(baseUrl);
    expect((await client.request('GET', '/api/health/live')).status).toBe(200);
    const ready = await client.request('GET', '/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: true, migrations: true, accepting: true });
  });
});

describe('sessions and request protection', () => {
  it('creates a guest session behind CSRF and Origin checks', async () => {
    const client = new TestClient(baseUrl);
    const first = await client.request('GET', '/api/session');
    expect(first.body).toMatchObject({ session: null });
    expect(first.body.csrfToken).toBe(client.cookies.get('dg_csrf'));

    const noToken = await client.request('POST', '/api/session', { displayName: 'Ana' }, { 'x-csrf-token': '' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.code).toBe('CSRF_FAILED');

    const badOrigin = await client.request('POST', '/api/session', { displayName: 'Ana' }, { origin: 'https://evil.example' });
    expect(badOrigin.body.code).toBe('ORIGIN_REJECTED');

    const created = await client.request('POST', '/api/session', { displayName: '  Ana  ', avatar: [3, 7, 1] });
    expect(created.status).toBe(201);
    expect(client.cookies.get('dg_sid')).toBeTruthy();
    expect((await client.request('GET', '/api/session')).body.session).toEqual({ name: 'Ana', avatar: [3, 7, 1] });

    expect((await client.request('POST', '/api/session', { displayName: 'Ana', avatar: [99, 0, 0] })).status).toBe(400);
    const renamed = await client.request('POST', '/api/session', { displayName: 'Ana B' });
    expect(renamed.body.session).toEqual({ name: 'Ana B', avatar: [3, 7, 1] });
  });

  it('rejects unknown fields, markup in names and malformed JSON', async () => {
    const client = new TestClient(baseUrl);
    await client.request('GET', '/api/session');
    expect((await client.request('POST', '/api/session', { displayName: 'A', admin: true })).status).toBe(400);
    expect((await client.request('POST', '/api/session', { displayName: '<b>x</b>' })).status).toBe(400);
    expect((await client.request('POST', '/api/session', '{"displayName":')).status).toBe(400);
  });

  it('returns structured errors for unknown API routes', async () => {
    const res = await new TestClient(baseUrl).request('GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
  });
});

describe('rooms', () => {
  it('creates a room with an invitation link, joins it, and keeps outsiders out', async () => {
    const [host, guest, outsider] = await signedInClients(server, ['Host', 'Guest', 'Outsider']);
    const room = await host!.createRoom();
    expect(room.code).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const joined = await guest!.join(room.code);
    expect(joined.playerId).not.toBe(room.playerId);
    const again = await guest!.join(room.code);
    expect(again.playerId).toBe(joined.playerId);

    const summary = await guest!.request('GET', `/api/rooms/${room.code}`);
    expect(summary.status).toBe(200);
    expect(summary.body.state.hostId).toBe(room.playerId);
    expect(summary.body.state.players.map((p: { name: string }) => p.name)).toEqual(['Host', 'Guest']);

    expect((await outsider!.request('GET', `/api/rooms/${room.code}`)).body.code).toBe('NOT_MEMBER');
    expect((await outsider!.request('GET', '/api/rooms/AAAAAAAAAAAAAAAA')).status).toBe(404);
    expect((await outsider!.request('POST', '/api/rooms/not-a-code/join')).status).toBe(404);
  });

  it('requires a session to create rooms', async () => {
    const anonymous = new TestClient(baseUrl);
    await anonymous.request('GET', '/api/session');
    expect((await anonymous.request('POST', '/api/rooms')).body.code).toBe('UNAUTHENTICATED');
  });

  it('lets only the host edit settings and validates custom word lists', async () => {
    const [host, guest] = await signedInClients(server, ['Host2', 'Guest2']);
    const { code } = await host!.createRoom();
    await guest!.join(code);
    const words = Array.from({ length: 12 }, (_, i) => `word ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`);
    const settings = { rounds: 2, drawTimeSec: 45, maxPlayers: 6, wordMode: 'custom', customWords: words };

    expect((await guest!.request('PUT', `/api/rooms/${code}/settings`, { version: 0, settings })).body.code).toBe(
      'NOT_HOST',
    );
    const saved = await host!.request('PUT', `/api/rooms/${code}/settings`, { version: 0, settings });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(1);
    expect((await host!.request('PUT', `/api/rooms/${code}/settings`, { version: 0, settings })).body.code).toBe(
      'SETTINGS_CONFLICT',
    );

    const invalid = await host!.request('PUT', `/api/rooms/${code}/settings`, {
      version: 1,
      settings: { ...settings, customWords: ['only', 'three', 'words'] },
    });
    expect(invalid.status).toBe(400);

    const huge = JSON.stringify({ version: 1, settings: { ...settings, customWords: ['x'.repeat(40_000)] } });
    expect((await host!.request('PUT', `/api/rooms/${code}/settings`, huge)).status).toBe(413);

    const publicView = await guest!.request('GET', `/api/rooms/${code}`);
    expect(publicView.body.state.settings).toEqual({
      rounds: 2,
      drawTimeSec: 45,
      maxPlayers: 6,
      wordMode: 'custom',
      customWordCount: 12,
    });
    expect(JSON.stringify(publicView.body)).not.toContain('word aa');
    expect((await host!.request('GET', `/api/rooms/${code}/settings`)).body.settings.customWords).toEqual(words);
  });
});
