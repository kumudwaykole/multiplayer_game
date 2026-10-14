import { describe, expect, it } from 'vitest';
import { buildMask, chooseHintPositions, hintCount, hintSchedule } from '../../src/game/hints.js';
import { guesserPoints, drawerPoints, rankPlayers } from '../../src/game/scoring.js';
import { validateSettings } from '../../src/game/settings.js';
import {
  boundedEditDistance,
  cleanChat,
  cleanName,
  guessKey,
  isCloseGuess,
  normalizeDisplay,
} from '../../src/game/text.js';
import { pickWords, validateCustomWords } from '../../src/game/words.js';
import { TokenBucket, takeAll } from '../../src/lib/rateLimit.js';

describe('text normalization', () => {
  it('normalizes display text with NFKC, trimming and collapsed whitespace', () => {
    expect(normalizeDisplay('  ｈｅｌｌｏ   world \n')).toBe('hello world');
  });

  it('guess keys ignore case, spacing and punctuation', () => {
    expect(guessKey('Ice-Cream!')).toBe('icecream');
    expect(guessKey('  ice   cream ')).toBe('icecream');
    expect(guessKey('ＣＡＴ')).toBe('cat');
  });

  it('rejects control characters, markup and over-long names', () => {
    expect(cleanName('Maya')).toBe('Maya');
    expect(cleanName('<b>Maya</b>')).toBeNull();
    expect(cleanName('a‮b')).toBeNull();
    expect(cleanName('x'.repeat(25))).toBeNull();
    expect(cleanName('   ')).toBeNull();
  });

  it('limits chat to 200 characters and 1 KiB', () => {
    expect(cleanChat('hello')).toBe('hello');
    expect(cleanChat('a'.repeat(200))).toHaveLength(200);
    expect(cleanChat('a'.repeat(201))).toBeNull();
    expect(cleanChat('😀'.repeat(200))).not.toBeNull();
    expect(cleanChat('\u0007bell')).toBeNull();
    expect(cleanChat('   ')).toBeNull();
  });
});

describe('near misses', () => {
  it('computes bounded edit distance', () => {
    expect(boundedEditDistance('kitten', 'sitting', 3)).toBe(3);
    expect(boundedEditDistance('kitten', 'sitting', 1)).toBe(2);
    expect(boundedEditDistance('abc', 'abc', 2)).toBe(0);
  });

  it('flags distance 1 for answers of 4+ letters', () => {
    expect(isCloseGuess('hous', 'house')).toBe(true);
    expect(isCloseGuess('mouse', 'house')).toBe(true);
    expect(isCloseGuess('mouses', 'house')).toBe(false);
  });

  it('allows distance 2 for answers of 8+ letters', () => {
    expect(isCloseGuess('elefant', 'elephant')).toBe(true);
    expect(isCloseGuess('elephnt', 'elephant')).toBe(true);
    expect(isCloseGuess('eleph', 'elephant')).toBe(false);
  });

  it('never flags short answers or exact matches', () => {
    expect(isCloseGuess('cot', 'cat')).toBe(false);
    expect(isCloseGuess('house', 'house')).toBe(false);
  });
});

describe('hints', () => {
  it('reveals at most min(3, floor(letters / 2)) positions', () => {
    expect(hintCount('ox')).toBe(1);
    expect(hintCount('cat')).toBe(1);
    expect(hintCount('house')).toBe(2);
    expect(hintCount('elephant')).toBe(3);
    expect(hintCount('ice cream')).toBe(3);
  });

  it('uses the later thresholds for fewer hints', () => {
    expect(hintSchedule(3)).toEqual([0.35, 0.6, 0.8]);
    expect(hintSchedule(1)).toEqual([0.8]);
    expect(hintSchedule(0)).toEqual([]);
  });

  it('chooses distinct letter positions and always leaves one hidden', () => {
    for (let i = 0; i < 50; i++) {
      const word = 'hot dog';
      const positions = chooseHintPositions(word);
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions.every((p) => word[p] !== ' ')).toBe(true);
      expect(buildMask(word, new Set(positions))).toContain('_');
    }
  });

  it('masks letters but shows spaces and punctuation', () => {
    expect(buildMask("yo-yo it's", new Set())).toBe("__-__ __'_");
    expect(buildMask('cat', new Set([1]))).toBe('_a_');
  });
});

describe('scoring', () => {
  it('awards 100 to 500 points by remaining time', () => {
    expect(guesserPoints(80_000, 80_000)).toBe(500);
    expect(guesserPoints(40_000, 80_000)).toBe(300);
    expect(guesserPoints(0, 80_000)).toBe(100);
    expect(guesserPoints(-5, 80_000)).toBe(100);
    expect(guesserPoints(99_999, 80_000)).toBe(500);
  });

  it('gives the drawer 50 per correct guesser', () => {
    expect(drawerPoints(0)).toBe(0);
    expect(drawerPoints(3)).toBe(150);
  });

  it('ranks ties equally and orders the display by name', () => {
    const ranked = rankPlayers([
      { playerId: '3', name: 'Cleo', score: 200 },
      { playerId: '1', name: 'Ana', score: 300 },
      { playerId: '2', name: 'Bo', score: 200 },
      { playerId: '4', name: 'Dee', score: 50 },
    ]);
    expect(ranked.map((r) => [r.name, r.rank])).toEqual([
      ['Ana', 1],
      ['Bo', 2],
      ['Cleo', 2],
      ['Dee', 4],
    ]);
  });
});

describe('word lists', () => {
  const ten = ['apple', 'banana', 'cherry', 'dates', 'eggplant', 'fig', 'grape', 'honeydew', 'kiwi', 'lemon'];

  it('accepts 10-500 unique English words and normalizes them', () => {
    const result = validateCustomWords([...ten.slice(0, 9), '  Ice   Cream ']);
    expect(result).toEqual({ ok: true, words: [...ten.slice(0, 9), 'ice cream'] });
  });

  it('rejects duplicates by guess key, markup, bad lengths and too few words', () => {
    expect(validateCustomWords([...ten, 'Apple!']).ok).toBe(false);
    expect(validateCustomWords([...ten, 'ice-cream', 'ice cream']).ok).toBe(false);
    expect(validateCustomWords([...ten, '<script>']).ok).toBe(false);
    expect(validateCustomWords([...ten, 'x']).ok).toBe(false);
    expect(validateCustomWords([...ten, 'a'.repeat(33)]).ok).toBe(false);
    expect(validateCustomWords(ten.slice(0, 9)).ok).toBe(false);
  });

  it('requires a valid custom list in custom mode', () => {
    expect(validateSettings({ rounds: 3, drawTimeSec: 80, maxPlayers: 8, wordMode: 'custom', customWords: [] }).ok).toBe(
      false,
    );
    expect(
      validateSettings({ rounds: 3, drawTimeSec: 80, maxPlayers: 8, wordMode: 'custom', customWords: ten }).ok,
    ).toBe(true);
  });

  it('picks distinct unused words and recycles the pool when it runs low', () => {
    const used = new Set<string>();
    const pool = ['a1', 'b2', 'c3', 'd4'];
    const first = pickWords(pool, used, 3);
    expect(new Set(first).size).toBe(3);
    const second = pickWords(pool, used, 3);
    expect(new Set(second).size).toBe(3);
    expect(second.every((w) => pool.includes(w))).toBe(true);
  });
});

describe('token buckets', () => {
  it('allows the burst, then refills at the sustained rate', () => {
    const bucket = new TokenBucket(5, 2, 0);
    for (let i = 0; i < 5; i++) expect(bucket.take(1, 0).ok).toBe(true);
    const denied = bucket.take(1, 0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
    expect(bucket.take(1, 500).ok).toBe(true);
  });

  it('only spends when every bucket allows it', () => {
    const burst = new TokenBucket(5, 2, 0);
    const minute = new TokenBucket(1, 1, 0);
    expect(takeAll([burst, minute], 1, 0).ok).toBe(true);
    expect(takeAll([burst, minute], 1, 0).ok).toBe(false);
    expect(burst.check(4, 0).ok).toBe(true);
  });
});
