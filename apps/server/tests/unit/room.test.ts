import { describe, expect, it } from 'vitest';
import { CHOOSE_TIME_MS, INTERMISSION_MS } from '../../src/game/settings.js';
import { ServerEvents, type SnapshotPayload } from '../../src/realtime/protocol.js';
import { RoomHarness, type TestPlayer } from '../support/roomHarness.js';

const DRAW_MS = 80_000;

async function threePlayers(options?: ConstructorParameters<typeof RoomHarness>[0]) {
  const h = new RoomHarness(options);
  const ana = await h.addPlayer('ana');
  const bo = await h.addPlayer('bo');
  const cy = await h.addPlayer('cy');
  return { h, ana, bo, cy };
}

/** Starts a game; the first joiner (ana) draws first. */
async function startDrawing(options?: ConstructorParameters<typeof RoomHarness>[0]) {
  const setup = await threePlayers(options);
  await setup.h.start(setup.ana);
  const { word, turnId } = await setup.h.chooseWord(setup.ana);
  return { ...setup, word, turnId };
}

function everythingSentTo(h: RoomHarness, player: TestPlayer): string {
  return JSON.stringify(h.transport.received(player.socketId));
}

describe('lobby and start', () => {
  it('makes the first connected member host and requires three connected players', async () => {
    const h = new RoomHarness();
    const ana = await h.addPlayer('ana');
    const bo = await h.addPlayer('bo');
    expect(h.state(ana).hostId).toBe(ana.id);
    await expect(h.room.startGame(ana.id, ana.socketId)).rejects.toMatchObject({ code: 'NOT_ENOUGH_PLAYERS' });
    const cy = await h.addPlayer('cy');
    await expect(h.room.startGame(bo.id, bo.socketId)).rejects.toMatchObject({ code: 'NOT_HOST' });
    await h.start(ana);
    expect(h.state(cy).phase).toBe('CHOOSING');
  });

  it('rejects joins beyond capacity', async () => {
    const h = new RoomHarness({ settings: { maxPlayers: 3 } });
    await h.addPlayer('ana');
    await h.addPlayer('bo');
    await h.addPlayer('cy');
    await expect(h.room.join('session-dee', 'dee')).rejects.toMatchObject({ code: 'ROOM_FULL' });
  });

  it('lets only the host change settings, with optimistic versions, and never publishes custom words', async () => {
    const { h, ana, bo } = await threePlayers();
    const words = ['apple', 'banana', 'cherry', 'dates', 'eggplant', 'fig', 'grape', 'honeydew', 'kiwi', 'lemon'];
    const settings = { rounds: 2, drawTimeSec: 30, maxPlayers: 8, wordMode: 'custom' as const, customWords: words };
    await expect(h.room.updateSettings(bo.sessionId, 0, settings)).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(h.room.updateSettings(ana.sessionId, 5, settings)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' });
    const saved = await h.room.updateSettings(ana.sessionId, 0, settings);
    expect(saved.version).toBe(1);
    await h.settle();
    expect(h.state(bo).settings).toEqual({ rounds: 2, drawTimeSec: 30, maxPlayers: 8, wordMode: 'custom', customWordCount: 10 });
    expect(everythingSentTo(h, bo)).not.toContain('honeydew');
  });
});

describe('word choice and secrecy', () => {
  it('offers three words to the drawer only', async () => {
    const { h, ana, bo, cy } = await threePlayers();
    await h.start(ana);
    const offer = h.choices(ana)!;
    expect(offer.choices).toHaveLength(3);
    expect(h.choices(bo)).toBeUndefined();
    for (const { word } of offer.choices) {
      expect(everythingSentTo(h, bo)).not.toContain(`"${word}"`);
      expect(everythingSentTo(h, cy)).not.toContain(`"${word}"`);
    }
  });

  it('auto-selects one of the offered words when the drawer does not choose', async () => {
    const { h, ana, bo } = await threePlayers();
    await h.start(ana);
    await h.advance(CHOOSE_TIME_MS);
    expect(h.state(bo).phase).toBe('DRAWING');
    const word = h.transport.last<{ word: string }>(ana.socketId, ServerEvents.wordSelected)!.word;
    expect(h.choices(ana)!.choices.map((c) => c.word)).toContain(word);
  });

  it('only the drawer may choose, and only an offered candidate', async () => {
    const { h, ana, bo } = await threePlayers();
    await h.start(ana);
    const offer = h.choices(ana)!;
    await expect(h.room.selectWord(bo.id, bo.socketId, offer.turnId, offer.choices[0]!.id)).rejects.toMatchObject({
      code: 'NOT_DRAWER',
    });
    await expect(h.room.selectWord(ana.id, ana.socketId, offer.turnId, 'nope')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('never sends the active answer to guessers: only a mask, then hints', async () => {
    const { h, bo, word } = await startDrawing();
    const state = h.state(bo);
    expect(state.turn!.mask).toMatch(/^[_ '-]+$/);
    expect(state.turn!.mask!.length).toBe(word.length);
    expect(everythingSentTo(h, bo)).not.toContain(`"${word}"`);
    await h.advance(DRAW_MS * 0.81);
    const mask = h.state(bo).turn!.mask!;
    const revealed = [...mask].filter((ch) => /[a-z0-9]/.test(ch)).length;
    const letters = [...word].filter((ch) => /[a-z0-9]/.test(ch)).length;
    expect(revealed).toBe(Math.min(3, Math.floor(letters / 2)));
    expect(mask).toContain('_');
  });
});

describe('guessing and scoring', () => {
  it('scores a correct guess by remaining time and hides its text', async () => {
    const { h, bo, cy, word } = await startDrawing();
    await h.advance(DRAW_MS / 2);
    const outcome = await h.say(bo, word.toUpperCase());
    expect(outcome.result).toBe('correct');
    expect(h.state(cy).players.find((p) => p.id === bo.id)!.score).toBe(300);
    expect(h.state(cy).turn!.guessedIds).toEqual([bo.id]);
    const cyChat = h.chat(cy).map((c) => c.message);
    expect(cyChat.at(-1)).toMatchObject({ kind: 'system', event: 'guessed', playerId: bo.id });
    expect(JSON.stringify(cyChat)).not.toContain(word);
  });

  it('locks chat for correct guessers and the drawer during the turn', async () => {
    const { h, ana, bo, word } = await startDrawing();
    await h.say(bo, word);
    await expect(h.say(bo, 'it was easy')).rejects.toMatchObject({ code: 'CHAT_LOCKED' });
    await expect(h.say(ana, 'hint: it is red')).rejects.toMatchObject({ code: 'CHAT_LOCKED' });
  });

  it('shows wrong guesses publicly and tells only the guesser about a near miss', async () => {
    // Near misses need answers of 4+ letters, so use a list of long words.
    const customWords = ['giraffe', 'penguin', 'volcano', 'pyramid', 'rainbow', 'octopus', 'lantern', 'cactus', 'dragon', 'rocket'];
    const { h, bo, cy, word } = await startDrawing({ settings: { wordMode: 'custom', customWords } });
    const nearMiss = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
    expect((await h.say(bo, nearMiss)).result).toBe('close');
    expect(h.transport.last(bo.socketId, ServerEvents.guessResult)).toMatchObject({ status: 'close' });
    expect(h.transport.received(cy.socketId, ServerEvents.guessResult)).toHaveLength(0);
    expect(h.chat(cy).at(-1)!.message).toMatchObject({ kind: 'player', text: nearMiss });
    expect((await h.say(bo, 'zzzzzz')).result).toBe('incorrect');
  });

  it('gives no points for a guess received at or after the deadline, even if the timer is late', async () => {
    const { h, bo, word } = await startDrawing();
    const deadlineMono = h.clock.now() + DRAW_MS;
    const outcome = await h.room.chat(bo.id, bo.socketId, 'late-1', word, deadlineMono);
    expect(outcome.result).toBe('late');
    expect(h.repo.awards.size).toBe(0);
  });

  it('awards a retried guess command only once', async () => {
    const { h, bo, word } = await startDrawing();
    const first = await h.room.chat(bo.id, bo.socketId, 'same-id', word, h.clock.now());
    const retry = await h.room.chat(bo.id, bo.socketId, 'same-id', word, h.clock.now());
    expect(first).toEqual(retry);
    expect(h.repo.awards.size).toBe(1);
  });

  it('ends the turn when everyone guessed, reveals the answer and pays the drawer', async () => {
    const { h, ana, bo, cy, word } = await startDrawing();
    await h.say(bo, word);
    await h.say(cy, word);
    const state = h.state(ana);
    expect(state.phase).toBe('TURN_RESULT');
    expect(state.turnResult).toMatchObject({ reason: 'ALL_GUESSED', answer: word, drawerId: ana.id });
    expect(state.players.find((p) => p.id === ana.id)!.score).toBe(100);
  });

  it('ends the turn at the deadline and moves to the next drawer after the intermission', async () => {
    const { h, ana, bo } = await startDrawing();
    await h.advance(DRAW_MS);
    expect(h.state(bo).turnResult!.reason).toBe('TIME_UP');
    await h.advance(INTERMISSION_MS);
    const state = h.state(ana);
    expect(state.phase).toBe('CHOOSING');
    expect(state.turn!.drawerId).toBe(bo.id);
  });

  it('runs every player once per round and finishes with a ranking', async () => {
    const { h, ana, bo, cy } = await threePlayers({ settings: { rounds: 1 } });
    await h.start(ana);
    for (const drawer of [ana, bo, cy]) {
      expect(h.state(ana).turn!.drawerId).toBe(drawer.id);
      const { word } = await h.chooseWord(drawer);
      for (const guesser of [ana, bo, cy].filter((p) => p !== drawer)) await h.say(guesser, word);
      await h.advance(INTERMISSION_MS);
    }
    const state = h.state(ana);
    expect(state.phase).toBe('GAME_RESULT');
    expect(state.gameResult!.status).toBe('FINISHED');
    expect(state.gameResult!.ranking).toHaveLength(3);
    expect(state.gameResult!.ranking.every((r) => r.score > 0)).toBe(true);
    await h.room.returnToLobby(ana.id, ana.socketId);
    await h.settle();
    expect(h.state(bo).phase).toBe('LOBBY');
  });
});

describe('drawing', () => {
  it('streams sequenced operations to everyone and stores them before broadcasting', async () => {
    const { h, ana, bo, turnId } = await startDrawing();
    const begin = await h.draw(ana, turnId, {
      type: 'stroke.begin',
      strokeId: 's1',
      tool: 'pen',
      color: '#000000',
      width: 4,
      point: [1, 1],
    });
    await h.draw(ana, turnId, { type: 'stroke.points', strokeId: 's1', points: [[2, 2], [3, 3]] });
    await h.draw(ana, turnId, { type: 'stroke.end', strokeId: 's1' });
    expect(begin).toEqual({ canvasSeq: 1, actionId: 'a1' });
    expect(h.drawn(bo).map((op) => op.canvasSeq)).toEqual([1, 2, 3]);
    expect(h.drawn(ana)).toHaveLength(3);
    expect(h.repo.operations).toHaveLength(3);
  });

  it('rejects drawing from non-drawers and deduplicates retried commands', async () => {
    const { h, ana, bo, turnId } = await startDrawing();
    await expect(h.draw(bo, turnId, { type: 'clear' })).rejects.toMatchObject({ code: 'NOT_DRAWER' });
    const first = await h.draw(ana, turnId, { type: 'clear' }, 'retry-me');
    const again = await h.draw(ana, turnId, { type: 'clear' }, 'retry-me');
    expect(again).toEqual(first);
    expect(h.repo.operations).toHaveLength(1);
  });

  it('rolls back after a storage failure so sequences stay gap-free', async () => {
    const { h, ana, bo, turnId } = await startDrawing();
    await h.draw(ana, turnId, { type: 'clear' });
    // The batch write and the per-turn retry both fail.
    h.repo.failDrawingWrites = 2;
    await expect(h.draw(ana, turnId, { type: 'fill', point: [1, 1], color: '#ff0000' })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    await h.settle();
    const next = await h.draw(ana, turnId, { type: 'fill', point: [1, 1], color: '#ff0000' });
    expect(next.canvasSeq).toBe(2);
    expect(h.drawn(bo).map((op) => op.canvasSeq)).toEqual([1, 2]);
  });

  it('sends a late joiner the canvas as it stands and treats them as a spectator', async () => {
    const { h, ana, turnId, word } = await startDrawing();
    await h.draw(ana, turnId, { type: 'fill', point: [5, 5], color: '#00ff00' });
    await h.draw(ana, turnId, { type: 'clear' });
    const dee = await h.addPlayer('dee');
    const snapshot = h.transport.last<SnapshotPayload>(dee.socketId, ServerEvents.snapshot)!;
    expect(snapshot.canvas).toMatchObject({ turnId, throughSeq: 2, chunkCount: 1 });
    const chunk = h.transport.last<{ ops: Array<{ canvasSeq: number }> }>(dee.socketId, ServerEvents.canvasChunk)!;
    expect(chunk.ops.map((op) => op.canvasSeq)).toEqual([1, 2]);
    expect(snapshot.state.players.find((p) => p.id === dee.id)!.role).toBe('spectator');
    // A spectator typing the answer must not reveal it to anyone.
    expect((await h.say(dee, word)).result).toBe('not_eligible');
    expect(JSON.stringify(h.transport.broadcasts)).not.toContain(`"text":"${word}"`);
  });
});

describe('disconnects and recovery', () => {
  it('restores the same player and score after a refresh within the grace period', async () => {
    const { h, bo, cy, word } = await startDrawing();
    await h.say(bo, word);
    const score = h.state(cy).players.find((p) => p.id === bo.id)!.score;
    await h.disconnect(bo);
    expect(h.state(cy).players.find((p) => p.id === bo.id)).toMatchObject({ connected: false, present: true });
    await h.advance(20_000);
    await h.room.join(bo.sessionId, bo.name);
    await h.reconnect(bo);
    const state = h.state(bo);
    expect(state.players.find((p) => p.id === bo.id)).toMatchObject({ connected: true, score });
  });

  it('ignores the stale disconnect of a replaced connection', async () => {
    const { h, bo, cy } = await threePlayers();
    const oldSocket = bo.socketId;
    await h.reconnect(bo);
    expect(h.transport.received(oldSocket, ServerEvents.replaced)).toHaveLength(1);
    await h.room.disconnect(bo.id, oldSocket);
    await h.settle();
    expect(h.state(cy).players.find((p) => p.id === bo.id)!.connected).toBe(true);
  });

  it('ends the turn immediately when the drawer disconnects, and reconnecting does not reopen it', async () => {
    const { h, ana, bo, turnId } = await startDrawing();
    await h.disconnect(ana);
    expect(h.state(bo).turnResult).toMatchObject({ turnId, reason: 'DRAWER_DISCONNECTED' });
    await h.reconnect(ana);
    expect(h.state(ana).phase).toBe('TURN_RESULT');
    await expect(h.draw(ana, turnId, { type: 'clear' })).rejects.toMatchObject({ code: 'WRONG_PHASE' });
  });

  it('abandons word selection when the drawer leaves while choosing', async () => {
    const { h, ana, bo } = await threePlayers();
    await h.start(ana);
    await h.room.leave(ana.id, ana.socketId);
    await h.settle();
    const state = h.state(bo);
    expect(state.turnResult).toMatchObject({ reason: 'DRAWER_LEFT', answer: null });
    expect(state.hostId).toBe(bo.id);
  });

  it('stops waiting for a guesser whose grace period expires', async () => {
    const { h, bo, cy, word } = await startDrawing();
    await h.say(bo, word);
    await h.disconnect(cy);
    expect(h.state(bo).phase).toBe('DRAWING');
    await h.advance(30_000);
    expect(h.state(bo).turnResult!.reason).toBe('ALL_GUESSED');
  });

  it('interrupts the game when fewer than two players remain', async () => {
    const { h, bo, cy } = await startDrawing();
    await h.room.leave(bo.id, bo.socketId);
    await h.room.leave(cy.id, cy.socketId);
    await h.settle();
    const ana = h.players.get('ana')!;
    const state = h.state(ana);
    expect(state.phase).toBe('LOBBY');
    expect(state.gameResult!.status).toBe('INTERRUPTED');
  });

  it('closes an empty room after the idle timeout', async () => {
    const { h, ana, bo, cy } = await threePlayers();
    for (const p of [ana, bo, cy]) await h.room.leave(p.id, p.socketId);
    await h.settle();
    expect(h.closed).toBe(false);
    await h.advance(30 * 60_000);
    expect(h.closed).toBe(true);
    await expect(h.room.join('session-new', 'new')).rejects.toMatchObject({ code: 'ROOM_CLOSED' });
  });
});
