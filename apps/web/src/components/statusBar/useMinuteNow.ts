import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/** Re-renders only its caller, once a minute. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- minute timer for reset countdowns
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
