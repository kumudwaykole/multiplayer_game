export const GUESS_BASE_POINTS = 100;
export const GUESS_SPEED_POINTS = 400;
export const DRAWER_POINTS_PER_GUESS = 50;

/**
 * Points for a first correct guess. `remainingMs` is measured on the server's
 * monotonic clock at ingress; client timestamps are never used.
 */
export function guesserPoints(remainingMs: number, durationMs: number): number {
  const remaining = Math.min(Math.max(remainingMs, 0), durationMs);
  return GUESS_BASE_POINTS + Math.floor((GUESS_SPEED_POINTS * remaining) / durationMs);
}

export function drawerPoints(correctGuessers: number): number {
  return DRAWER_POINTS_PER_GUESS * correctGuessers;
}

export interface RankInput {
  playerId: string;
  name: string;
  score: number;
}

/** Equal scores share a rank (1, 2, 2, 4). Name then ID only orders the display. */
export function rankPlayers<T extends RankInput>(players: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...players].sort(
    (a, b) =>
      b.score - a.score ||
      a.name.localeCompare(b.name, 'en') ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
  let rank = 0;
  let previousScore: number | null = null;
  return sorted.map((player, index) => {
    if (player.score !== previousScore) {
      rank = index + 1;
      previousScore = player.score;
    }
    return { ...player, rank };
  });
}
