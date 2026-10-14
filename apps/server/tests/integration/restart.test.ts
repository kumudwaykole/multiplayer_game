import { describe, expect, it } from 'vitest';
import { TestClient, signedInClients, startTestServer } from './support.js';

async function playUntilMidTurn() {
  const server = await startTestServer();
  const [ana, bo, cy] = await signedInClients(server, ['Ana', 'Bo', 'Cy']);
  const { code } = await ana!.createRoom();
  await bo!.join(code);
  await cy!.join(code);
  for (const client of [ana!, bo!, cy!]) {
    await client.connect();
    await client.subscribe(code);
  }
  await ana!.send('game:start');
  const offer = await ana!.waitFor('word:choices');
  await ana!.send('word:select', { turnId: offer.turnId, candidateId: offer.choices[0].id });
  const word: string = (await ana!.waitFor('word:selected')).word;
  const turnId: string = offer.turnId;
  await ana!.send('draw:operation', { turnId, op: { type: 'fill', point: [10, 10], color: '#ff0000' } });
  await ana!.send('draw:operation', { turnId, op: { type: 'clear' } });
  expect(await bo!.send('chat:send', { text: word })).toMatchObject({ result: 'correct' });
  const gameId: string = bo!.last('room:state').state.game.id;
  return { server, code, clients: [ana!, bo!, cy!] as const, turnId, gameId, word };
}

describe('server restart', () => {
  it('after a crash, closes the active turn, keeps committed scores and drawings, and lets players rejoin', async () => {
    const { server, code, clients, turnId, gameId } = await playUntilMidTurn();
    const [ana, bo] = clients;
    const boPlayerId = bo.last('room:snapshot').you.playerId;

    // Crash: no shutdown work at all.
    await server.kill();
    for (const client of clients) client.close();

    const restarted = await startTestServer();
    try {
      const turn = await restarted.prisma.turn.findUniqueOrThrow({
        where: { id: turnId },
        include: { finalization: true, awards: true },
      });
      expect(turn).toMatchObject({ status: 'ENDED', endReason: 'SERVER_RESTART', finalCanvasSeq: 2 });
      expect(turn.awards).toHaveLength(1);
      expect(turn.finalization?.drawerPoints).toBe(50);
      const game = await restarted.prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: { players: true } });
      expect(game.status).toBe('INTERRUPTED');
      expect(game.players.map((p) => p.score).sort((a, b) => a - b)).toEqual([0, 50, expect.any(Number)]);

      // Same browser (cookie) comes back to the same player in the lobby.
      const baseUrl = `http://127.0.0.1:${restarted.port}`;
      const boAgain = new TestClient(baseUrl);
      for (const [name, value] of bo.cookies) boAgain.cookies.set(name, value);
      const rejoined = await boAgain.join(code);
      expect(rejoined.playerId).toBe(boPlayerId);
      await boAgain.connect();
      const snapshot = await boAgain.subscribe(code);
      expect(snapshot.state.phase).toBe('LOBBY');
      expect(snapshot.you.playerId).toBe(boPlayerId);
      boAgain.close();

      // The interrupted drawing is still replayable.
      const anaAgain = new TestClient(baseUrl);
      for (const [name, value] of ana.cookies) anaAgain.cookies.set(name, value);
      const replay = await anaAgain.request('GET', `/api/turns/${turnId}/replay`);
      expect(replay.body.ops.map((op: { operation: { type: string } }) => op.operation.type)).toEqual(['fill', 'clear']);
    } finally {
      await restarted.stop('test');
    }
  });

  it('on a planned shutdown, notifies clients and closes the turn before exiting', async () => {
    const { server, clients, turnId, gameId } = await playUntilMidTurn();
    const [, bo] = clients;
    const draining = bo.waitFor('server:draining');
    await server.stop('test');
    expect(await draining).toMatchObject({ reconnectAfterMs: expect.any(Number) });
    for (const client of clients) client.close();

    const check = await startTestServer();
    try {
      const turn = await check.prisma.turn.findUniqueOrThrow({ where: { id: turnId } });
      expect(turn).toMatchObject({ status: 'ENDED', endReason: 'SERVER_RESTART' });
      const game = await check.prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game.status).toBe('INTERRUPTED');
    } finally {
      await check.stop('test');
    }
  });
});
