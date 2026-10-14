/**
 * Text rules shared by words, guesses, chat and names.
 *
 * Display normalization: Unicode NFKC, trim, collapse whitespace.
 * Guess key: display normalization, lowercase, then keep only a-z and 0-9.
 * So "Ice-Cream!", "ice cream" and "icecream" all have the key "icecream".
 * A guess is correct only when its key equals the answer key exactly.
 */

// C0/C1 controls, plus bidi overrides and zero-width characters that can hide text.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const MARKUP = /[<>]/;

export function normalizeDisplay(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function guessKey(input: string): string {
  return normalizeDisplay(input)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function hasControlChars(input: string): boolean {
  return CONTROL_CHARS.test(input);
}

export function hasMarkup(input: string): boolean {
  return MARKUP.test(input);
}

/** Unicode code point count (what the user perceives as characters, roughly). */
export function charLength(input: string): number {
  let count = 0;
  for (const _ of input) count++;
  return count;
}

export const CHAT_MAX_CHARS = 200;
export const CHAT_MAX_BYTES = 1024;

/** Returns the cleaned chat text, or null when it must be rejected. */
export function cleanChat(input: string): string | null {
  if (hasControlChars(input)) return null;
  const text = normalizeDisplay(input);
  if (text.length === 0) return null;
  if (charLength(text) > CHAT_MAX_CHARS) return null;
  if (Buffer.byteLength(text, 'utf8') > CHAT_MAX_BYTES) return null;
  return text;
}

export const NAME_MAX_CHARS = 24;

/** Display names: 1-24 characters, no control characters or markup. */
export function cleanName(input: string): string | null {
  if (hasControlChars(input) || hasMarkup(input)) return null;
  const name = normalizeDisplay(input);
  const length = charLength(name);
  if (length < 1 || length > NAME_MAX_CHARS) return null;
  return name;
}

const EDIT_LIMIT = 64;

/**
 * Levenshtein distance capped at `max`: returns max + 1 as soon as the
 * distance is known to exceed it. Inputs are cut to 64 characters.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  const s = a.slice(0, EDIT_LIMIT);
  const t = b.slice(0, EDIT_LIMIT);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return Math.min(previous[t.length]!, max + 1);
}

/**
 * Near-miss rule (game design default): distance 1 for answers of at least
 * 4 characters, or up to 2 for answers of at least 8. Both arguments are guess keys.
 */
export function isCloseGuess(guess: string, answer: string): boolean {
  if (guess.length === 0 || guess === answer) return false;
  const allowed = answer.length >= 8 ? 2 : answer.length >= 4 ? 1 : 0;
  if (allowed === 0) return false;
  return boundedEditDistance(guess, answer, allowed) <= allowed;
}
