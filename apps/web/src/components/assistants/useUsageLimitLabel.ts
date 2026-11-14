import { usageLimitLabel } from "@t3tools/client-runtime/assistantTasks";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { formatUpcomingTimestamp } from "../../timestampFormat";

/** "Limit until 14:30" (with the day when not today) in the app's time format; null without a reset ahead. */
export function useUsageLimitLabel() {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const now = useNowMinuteMs();
  return (resetAt: string | null | undefined) =>
    usageLimitLabel(resetAt, now, (iso) => formatUpcomingTimestamp(iso, timestampFormat, now));
}
