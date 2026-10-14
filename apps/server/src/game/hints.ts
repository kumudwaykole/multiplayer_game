import { randomInt } from 'node:crypto';

/** Fractions of the draw time at which letters are revealed. */
export const HINT_THRESHOLDS = [0.35, 0.6, 0.8] as const;

const LETTER = /[a-z0-9]/i;

export function letterPositions(word: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < word.length; i++) {
    if (LETTER.test(word[i]!)) positions.push(i);
  }
  return positions;
}

/** At most min(3, floor(letters / 2)) hints, so at least one letter stays hidden. */
export function hintCount(word: string): number {
  return Math.min(HINT_THRESHOLDS.length, Math.floor(letterPositions(word).length / 2));
}

/** Picks distinct letter positions to reveal, in reveal order, using a CSPRNG. */
export function chooseHintPositions(word: string): number[] {
  const pool = letterPositions(word);
  const count = hintCount(word);
  const chosen: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = randomInt(pool.length);
    chosen.push(pool[index]!);
    pool.splice(index, 1);
  }
  return chosen;
}

/**
 * The thresholds used for `count` hints. Fewer hints use the later thresholds
 * so short words are not given away early.
 */
export function hintSchedule(count: number): number[] {
  return HINT_THRESHOLDS.slice(HINT_THRESHOLDS.length - count);
}

/** Hidden letters become "_"; spaces and punctuation are visible from the start. */
export function buildMask(word: string, revealed: ReadonlySet<number>): string {
  let mask = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    mask += LETTER.test(ch) && !revealed.has(i) ? '_' : ch;
  }
  return mask;
}
