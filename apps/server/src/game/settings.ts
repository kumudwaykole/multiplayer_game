import { z } from 'zod';
import { BUILTIN_WORD_LIST_VERSION, BUILTIN_WORDS, validateCustomWords } from './words.js';

export const ROUNDS = { min: 1, max: 10, default: 3 } as const;
export const DRAW_TIME_SEC = { min: 30, max: 180, default: 80 } as const;
export const MAX_PLAYERS = { min: 3, max: 12, default: 8 } as const;
export const CHOOSE_TIME_MS = 12_000;
export const INTERMISSION_MS = 5_000;

export interface RoomSettings {
  rounds: number;
  drawTimeSec: number;
  maxPlayers: number;
  wordMode: 'builtin' | 'custom';
  /** Private host configuration; never part of public state. */
  customWords: string[];
}

/** What every member may see. The custom list itself stays with the host. */
export interface PublicSettings {
  rounds: number;
  drawTimeSec: number;
  maxPlayers: number;
  wordMode: 'builtin' | 'custom';
  customWordCount: number;
}

/** Settings frozen into a game when it starts. */
export interface FrozenGameSettings {
  rounds: number;
  drawTimeSec: number;
  maxPlayers: number;
  wordListVersion: string;
  /** Present only for custom lists; built-in lists are identified by version. */
  customWords?: string[];
}

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: ROUNDS.default,
  drawTimeSec: DRAW_TIME_SEC.default,
  maxPlayers: MAX_PLAYERS.default,
  wordMode: 'builtin',
  customWords: [],
};

export const settingsInputSchema = z.strictObject({
  rounds: z.number().int().min(ROUNDS.min).max(ROUNDS.max),
  drawTimeSec: z.number().int().min(DRAW_TIME_SEC.min).max(DRAW_TIME_SEC.max),
  maxPlayers: z.number().int().min(MAX_PLAYERS.min).max(MAX_PLAYERS.max),
  wordMode: z.enum(['builtin', 'custom']),
  customWords: z.array(z.string().max(256)).max(1000).default([]),
});

export type SettingsResult = { ok: true; settings: RoomSettings } | { ok: false; message: string };

/** Validates host input. A custom list is required in custom mode and kept (validated) otherwise. */
export function validateSettings(input: z.infer<typeof settingsInputSchema>): SettingsResult {
  let customWords: string[] = [];
  if (input.wordMode === 'custom' || input.customWords.length > 0) {
    const result = validateCustomWords(input.customWords);
    if (!result.ok) return result;
    customWords = result.words;
  }
  return {
    ok: true,
    settings: {
      rounds: input.rounds,
      drawTimeSec: input.drawTimeSec,
      maxPlayers: input.maxPlayers,
      wordMode: input.wordMode,
      customWords,
    },
  };
}

/** Reads settings stored as JSON, falling back to defaults for anything malformed. */
export function parseStoredSettings(value: unknown): RoomSettings {
  const parsed = settingsInputSchema.safeParse(value);
  if (!parsed.success) return { ...DEFAULT_SETTINGS };
  const validated = validateSettings(parsed.data);
  return validated.ok ? validated.settings : { ...DEFAULT_SETTINGS };
}

export function publicSettings(settings: RoomSettings): PublicSettings {
  return {
    rounds: settings.rounds,
    drawTimeSec: settings.drawTimeSec,
    maxPlayers: settings.maxPlayers,
    wordMode: settings.wordMode,
    customWordCount: settings.customWords.length,
  };
}

export function freezeSettings(settings: RoomSettings): FrozenGameSettings {
  if (settings.wordMode === 'custom') {
    return {
      rounds: settings.rounds,
      drawTimeSec: settings.drawTimeSec,
      maxPlayers: settings.maxPlayers,
      wordListVersion: 'custom',
      customWords: [...settings.customWords],
    };
  }
  return {
    rounds: settings.rounds,
    drawTimeSec: settings.drawTimeSec,
    maxPlayers: settings.maxPlayers,
    wordListVersion: BUILTIN_WORD_LIST_VERSION,
  };
}

export function wordPool(settings: FrozenGameSettings): readonly string[] {
  return settings.customWords && settings.customWords.length > 0 ? settings.customWords : BUILTIN_WORDS;
}
