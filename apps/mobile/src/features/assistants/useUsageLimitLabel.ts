import { usageLimitLabel } from "@t3tools/client-runtime/assistantTasks";

import { useNowMinuteMs } from "../../lib/clock";

const localDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());

/** "14:30" today, "tomorrow at 14:30", else "Nov 16 14:30", in the device's time format. */
export function formatUpcomingTime(iso: string, nowMs: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((localDay(at) - localDay(new Date(nowMs))) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** "Limit until 14:30" while the reset is ahead; null without one. */
export function useUsageLimitLabel() {
  const now = useNowMinuteMs();
  return (resetAt: string | null | undefined) =>
    usageLimitLabel(resetAt, now, (iso) => formatUpcomingTime(iso, now));
}
