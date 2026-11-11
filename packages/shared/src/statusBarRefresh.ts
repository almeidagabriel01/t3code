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

/**
 * Automatic usage refresh runs only for a timed interval, a visible window, and an elapsed interval.
 * `opening` is the first check after a page load: manual mode then fetches only a missing reading.
 */
export const shouldRefreshUsage = (input: {
  readonly intervalMs: number | null;
  readonly hidden: boolean;
  readonly lastRefreshAt: number;
  readonly now: number;
  readonly opening?: boolean;
}): boolean =>
  input.intervalMs === null
    ? input.opening === true && input.lastRefreshAt === 0
    : !input.hidden && input.now - input.lastRefreshAt >= input.intervalMs;

/** When the server last read usage: its oldest reading, 0 when it holds none. */
export const usageReadingAt = (checkedAts: ReadonlyArray<string>): number =>
  checkedAts.length === 0 ? 0 : Math.min(...checkedAts.map((at) => Date.parse(at))) || 0;
