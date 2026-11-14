import { usageLimitLabel } from "@t3tools/client-runtime/assistantTasks";

import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { formatUpcomingTimestamp } from "../../timestampFormat";

/** "Limit until 14:30", with the day when the reset is not today, in the app's time format. */
export function useUsageLimitLabel() {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const now = useNowMinuteMs();
  return (resetAt: string | null | undefined) =>
    usageLimitLabel(resetAt, now, (iso) => formatUpcomingTimestamp(iso, timestampFormat, now));
}
