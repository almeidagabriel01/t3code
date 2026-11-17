import { formatRowWorkingDurationLabel } from "@t3tools/client-runtime/state/models";

import { useNowMinuteMs } from "../../hooks/useNowMinute";

export function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) return null;
  return <WorkingDurationLabel startedMs={startedMs} />;
}

// Self-ticking on the shared minute tick, so a running row re-renders only this span, once a minute.
function WorkingDurationLabel(props: { startedMs: number }) {
  const nowMs = useNowMinuteMs();
  return (
    <span className="tabular-nums">{formatRowWorkingDurationLabel(nowMs - props.startedMs)}</span>
  );
}
