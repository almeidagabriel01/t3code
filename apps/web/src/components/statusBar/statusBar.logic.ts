import { formatCompactCountdown, shortLimitName } from "@t3tools/client-runtime/state/usageReset";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

/** The session and weekly windows lead with a countdown; any further windows follow compactly. */
export function selectBarWindows(windows: ReadonlyArray<ServerProviderUsageWindow>) {
  const session = windows.find((window) => window.kind === "session");
  const weekly = windows.find((window) => window.kind === "weekly");
  const primary = [session, weekly].filter((window) => window !== undefined);
  return {
    primary,
    extra: windows.filter((window) => !primary.includes(window)),
  };
}

export interface ChipEntry {
  readonly window: ServerProviderUsageWindow;
  /** Session and weekly each get their own bar; compact mode and extra windows are text only. */
  readonly bar: boolean;
  /** Short name read before the percentage: "Session", "Week", or a model such as "Fable". */
  readonly name: string;
  /** Time left before the window resets, read after the bar; null when it is not shown. */
  readonly resets: string | null;
}

/** Each window reads name, percentage, bar, then the session's time left. */
export function selectChipEntries(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  mode: "verbose" | "compact",
  now: number,
): ChipEntry[] {
  if (windows.length === 0) return [];
  if (mode === "compact") {
    const tightest = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    return [
      {
        window: tightest,
        bar: false,
        name: shortLimitName(tightest),
        resets: formatCompactCountdown(tightest.resetsAt, now),
      },
    ];
  }
  const { primary, extra } = selectBarWindows(windows);
  return [
    ...primary.map((window) => ({
      window,
      bar: true,
      name: shortLimitName(window),
      resets: window.kind === "session" ? formatCompactCountdown(window.resetsAt, now) : null,
    })),
    ...extra.map((window) => ({ window, bar: false, name: shortLimitName(window), resets: null })),
  ];
}

export function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** SVG polyline points for a series scaled to its own max; empty below two samples. */
export function sparklinePoints(
  values: ReadonlyArray<number>,
  width: number,
  height: number,
): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 1);
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const WILDCARD_HOSTS = new Set(["*", "0.0.0.0", "::"]);

/** What a client on the listener's machine would type: wildcard and loopback binds read as localhost. */
export function portAddress(host: string, port: number): string {
  const loopback = WILDCARD_HOSTS.has(host) || host === "127.0.0.1" || host === "::1";
  const name = loopback ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return `${name}:${port}`;
}
