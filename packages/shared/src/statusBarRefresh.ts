export const USAGE_REFRESH_MS = {
  "1m": 60_000,
  "2m": 120_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  manual: null,
} as const;

export const PORTS_REFRESH_MS = {
  "10s": 10_000,
  "30s": 30_000,
  "1m": 60_000,
  "5m": 300_000,
} as const;

/** Automatic usage refresh runs only for a timed interval, a visible window, and an elapsed interval. */
export const shouldRefreshUsage = (input: {
  readonly intervalMs: number | null;
  readonly hidden: boolean;
  readonly lastRefreshAt: number;
  readonly now: number;
}): boolean =>
  input.intervalMs !== null && !input.hidden && input.now - input.lastRefreshAt >= input.intervalMs;
