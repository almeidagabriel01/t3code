import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "3d12h", "3h49m", "12m"; null without a reset time. */
export function formatCompactCountdown(resetsAt: string | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  if (left < MINUTE) return "now";
  if (left >= DAY) return `${Math.floor(left / DAY)}d${Math.floor((left % DAY) / HOUR)}h`;
  if (left >= HOUR) return `${Math.floor(left / HOUR)}h${Math.floor((left % HOUR) / MINUTE)}m`;
  return `${Math.floor(left / MINUTE)}m`;
}

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
