const STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Reconnect delay for the given attempt (0-based) with ±20 % jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = STEPS_MS[Math.min(attempt, STEPS_MS.length - 1)] ?? 60_000;
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Attempt index that yields the longest delay (used after auth refusals). */
export const MAX_BACKOFF_ATTEMPT = STEPS_MS.length - 1;
