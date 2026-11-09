import type { ServerProviderUsageWindow, UsageResetDisplay } from "@t3tools/contracts";

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

/** "Weekly · Fable" reads as "Fable": the limit is already grouped under its window kind. */
export function shortLimitName(window: ServerProviderUsageWindow): string {
  const scoped = /^(?:weekly|monthly)\s*·\s*(.+)$/i.exec(window.label);
  if (scoped?.[1]) return scoped[1];
  if (window.kind === "session") return "Session";
  if (window.kind === "weekly") return "Week";
  if (window.kind === "monthly") return "Month";
  return window.label;
}

const isMultiDay = (window: ServerProviderUsageWindow) =>
  window.kind === "weekly" ||
  window.kind === "monthly" ||
  (window.windowDurationMins ?? 0) >= DAY / MINUTE;

export interface ResetFormatInput {
  readonly window: ServerProviderUsageWindow;
  readonly mode: UsageResetDisplay;
  readonly now: number;
  readonly locale?: string | undefined;
  readonly timeZone?: string | undefined;
  /** Undefined follows the locale. */
  readonly hour12?: boolean | undefined;
}

export interface ResetLabel {
  /** What the row shows. */
  readonly label: string;
  /** The label as a sentence, for rows with no room for a tooltip: "Resets Thu 12". */
  readonly phrase: string;
  /** Exact local date and time with the countdown, for the tooltip. */
  readonly title: string;
}

/** Multi-day limits show the reset day ("Thu 13", or the time within 24h); sessions keep the countdown. */
export function formatResetLabel(input: ResetFormatInput): ResetLabel | null {
  const { window, mode, now, locale, timeZone, hour12 } = input;
  const countdown = formatCompactCountdown(window.resetsAt, now);
  if (countdown === null || window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  const zone = timeZone === undefined ? {} : { timeZone };
  const clock = {
    hour: "numeric",
    minute: "2-digit",
    ...(hour12 === undefined ? {} : { hour12 }),
    ...zone,
  } as const;
  const title =
    countdown === "now"
      ? "Resets now"
      : `Resets ${new Intl.DateTimeFormat(locale, {
          weekday: "short",
          month: "short",
          day: "numeric",
          ...clock,
        }).format(at)} (in ${countdown})`;
  if (countdown === "now" || mode === "countdown" || !isMultiDay(window)) {
    return {
      label: countdown,
      title,
      phrase: countdown === "now" ? "Resets now" : `Resets in ${countdown}`,
    };
  }
  const parts = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    ...zone,
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const when =
    at - now < DAY
      ? new Intl.DateTimeFormat(locale, clock).format(at)
      : `${part("weekday")} ${part("day")}`;
  return mode === "both"
    ? { label: `${when} · ${countdown}`, title, phrase: `Resets ${when} · in ${countdown}` }
    : { label: when, title, phrase: `Resets ${when}` };
}
