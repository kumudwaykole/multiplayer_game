import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../src/server.js';
import { TestClient, signedInClients, startTestServer } from './support.js';

let server: RunningServer;
const clients: TestClient[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  for (const client of clients) client.close();
  await server.stop('test');
});

describe('a full turn over Socket.IO', () => {
  it('plays a turn end to end with streaming strokes, a late joiner, guesses and a replay', async () => {
    const [ana, bo, cy, dee] = await signedInClients(server, ['Ana', 'Bo', 'Cy', 'Dee']);
    clients.push(ana!, bo!, cy!, dee!);
    const { code } = await ana!.createRoom();
    await bo!.join(code);
    await cy!.join(code);
    for (const client of [ana!, bo!, cy!]) {
      await client.connect();
      const snapshot = await client.subscribe(code);
      expect(snapshot.state.code).toBe(code);
    }

    // Host starts; only the drawer (first joiner) is offered words.
    expect(await bo!.send('game:start')).toMatchObject({ ok: false, code: 'NOT_HOST' });
    expect(await ana!.send('game:start')).toMatchObject({ ok: true });
    const offer = await ana!.waitFor('word:choices');
    expect(offer.choices).toHaveLength(3);
    expect(bo!.all('word:choices')).toHaveLength(0);

    const choice = offer.choices[0];
    expect(await ana!.send('word:select', { turnId: offer.turnId, candidateId: choice.id })).toMatchObject({ ok: true });
    const started = await bo!.waitFor('room:state', (e) => e.reason === 'turn:started');
    expect(started.state.turn.mask).toMatch(/^[_ '-]+$/);
    const word: string = (await ana!.waitFor('word:selected')).word;
    expect(word).toBe(choice.word);

    // Drawing streams to every player in canvas sequence order.
    const turnId = offer.turnId;
    const ops = [
      { type: 'stroke.begin', strokeId: 's1', tool: 'pen', color: '#1e90ff', width: 8, point: [100, 100] },
      { type: 'stroke.points', strokeId: 's1', points: [[110, 105], [120, 112], [130, 120]] },
      { type: 'stroke.end', strokeId: 's1' },
    ];
    for (const op of ops) {
      const ack = await ana!.send('draw:operation', { turnId, op });
      expect(ack.ok).toBe(true);
    }
    await cy!.waitFor('draw:operation', (op) => op.canvasSeq === 3);
    expect(cy!.all('draw:operation').map((op) => op.canvasSeq)).toEqual([1, 2, 3]);
    expect(await bo!.send('draw:operation', { turnId, op: { type: 'clear' } })).toMatchObject({ code: 'NOT_DRAWER' });

    // A player joining mid-turn receives the canvas as it stands.
    await dee!.join(code);
    await dee!.connect();
    const snapshot = await dee!.subscribe(code);
    expect(snapshot.canvas).toMatchObject({ turnId, throughSeq: 3, chunkCount: 1 });
    const chunk = await dee!.waitFor('canvas:chunk');
    expect(chunk.ops.map((op: { canvasSeq: number }) => op.canvasSeq)).toEqual([1, 2, 3]);
    expect(snapshot.state.players.find((p: { name: string }) => p.name === 'Dee').role).toBe('spectator');

    // Wrong guesses are public; the correct one is private and locks chat.
    expect(await bo!.send('chat:send', { text: 'is it a boat?' })).toMatchObject({ ok: true, result: 'incorrect' });
    await cy!.waitFor('chat:message', (e) => e.message.text === 'is it a boat?');
    expect(await bo!.send('chat:send', { text: word.toUpperCase() })).toMatchObject({ ok: true, result: 'correct' });
    expect(await bo!.waitFor('guess:result', (e) => e.status === 'correct')).toMatchObject({ points: expect.any(Number) });
    expect(await bo!.send('chat:send', { text: `the word is ${word}` })).toMatchObject({ code: 'CHAT_LOCKED' });
    expect(await ana!.send('chat:send', { text: 'hello' })).toMatchObject({ code: 'CHAT_LOCKED' });
    expect(await dee!.send('chat:send', { text: word })).toMatchObject({ ok: true, result: 'not_eligible' });

    expect(await cy!.send('chat:send', { text: word })).toMatchObject({ ok: true, result: 'correct' });
    const ended = await dee!.waitFor('room:state', (e) => e.reason === 'turn:ended');
    expect(ended.state.turnResult).toMatchObject({ reason: 'ALL_GUESSED', answer: word, finalCanvasSeq: 3 });

    // No guesser saw the answer before the turn ended.
    for (const guesser of [bo!, cy!, dee!]) {
      const endIndex = guesser.events.findIndex((e) => e.event === 'room:state' && e.payload.reason === 'turn:ended');
      const before = JSON.stringify(guesser.events.slice(0, endIndex).filter((e) => e.event !== 'guess:result'));
      expect(before).not.toContain(`"${word}"`);
      expect(before).not.toContain(`"text":"${word}"`);
    }

    // Everything is durable in PostgreSQL.
    const stored = await server.prisma.drawingOperation.count({ where: { turnId } });
    const awards = await server.prisma.guessAward.count({ where: { turnId } });
    const turn = await server.prisma.turn.findUniqueOrThrow({ where: { id: turnId }, include: { finalization: true } });
    expect({ stored, awards, status: turn.status, drawerPoints: turn.finalization?.drawerPoints }).toEqual({
      stored: 3,
      awards: 2,
      status: 'ENDED',
      drawerPoints: 100,
    });

    // The finished drawing can be replayed by members only.
    const gameId = ended.state.game.id;
    const index = await bo!.request('GET', `/api/games/${gameId}/replays`);
    expect(index.body.turns).toEqual([
      expect.objectContaining({ turnId, answer: word, operationCount: 3, endReason: 'ALL_GUESSED' }),
    ]);
    const page = await dee!.request('GET', `/api/turns/${turnId}/replay?afterSeq=1`);
    expect(page.body.ops.map((op: { canvasSeq: number }) => op.canvasSeq)).toEqual([2, 3]);
    expect(page.body.nextAfterSeq).toBeNull();
    const [outsider] = await signedInClients(server, ['Eve']);
    expect((await outsider!.request('GET', `/api/turns/${turnId}/replay`)).status).toBe(404);
  });
});

describe('socket abuse protection', () => {
  it('rejects foreign origins and sockets without a session', async () => {
    const [client] = await signedInClients(server, ['Mallory']);
    await expect(client!.connect({ origin: 'https://evil.example' })).rejects.toThrow();
    await expect(client!.connect({ withCookies: false })).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('rate limits chat and validates message size', async () => {
    const [host, a, b] = await signedInClients(server, ['H', 'A', 'B']);
    clients.push(host!, a!, b!);
    const { code } = await host!.createRoom();
    await host!.connect();
    await host!.subscribe(code);

    const acks = await Promise.all(Array.from({ length: 12 }, (_, i) => host!.send('chat:send', { text: `msg ${i}` })));
    const limited = acks.filter((ack) => ack.code === 'RATE_LIMITED');
    expect(acks.filter((ack) => ack.ok)).toHaveLength(5);
    expect(limited.length).toBe(7);
    expect(limited[0].retryAfterMs).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await host!.send('chat:send', { text: 'x'.repeat(201) })).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await host!.send('chat:send', { text: 'x'.repeat(5000) })).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('disconnects a socket that sends a frame over 16 KiB', async () => {
    const [client] = await signedInClients(server, ['Big']);
    clients.push(client!);
    const socket = await client!.connect();
    const closed = new Promise((resolve) => socket.once('disconnect', resolve));
    socket.emit('chat:send', { commandId: 'big', text: 'x'.repeat(20_000) });
    expect(await closed).toBeTruthy();
  });
});
