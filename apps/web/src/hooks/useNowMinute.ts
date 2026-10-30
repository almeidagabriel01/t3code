import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

export function useNowMinute(): string {
  return useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot);
}

/** The minute tick as epoch ms. The tick has no offset, so a bare `Date.parse` would read it as local time. */
export function useNowMinuteMs(): number {
  return Date.parse(`${useNowMinute()}:00Z`);
}
