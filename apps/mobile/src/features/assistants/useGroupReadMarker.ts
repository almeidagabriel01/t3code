import { assistantGroupReadStep } from "@t3tools/client-runtime/assistantGroupChat";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState } from "react-native";

const MARK_DELAY_MS = 500;

/**
 * Tells the server how far the user has read once the newest message has been in view for a
 * moment: the app is in the foreground and the feed is scrolled to its end.
 */
export function useGroupReadMarker(input: {
  /** Null until the chat has loaded. */
  readonly latestSeq: number | null;
  readonly readSeq: number;
  readonly atBottom: boolean;
  readonly enabled: boolean;
  readonly markRead: (readSeq: number) => void;
}) {
  const { latestSeq, readSeq, atBottom, enabled } = input;
  const markRead = useEffectEvent(input.markRead);
  const [seen, setSeen] = useState(0);
  const step = assistantGroupReadStep({ latestSeq, readSeq, seen });
  if (step.seen !== seen) setSeen(step.seen);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- app state is native state
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const target = enabled && foreground && atBottom ? step.target : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that reports to the server
  useEffect(() => {
    if (target === null) return;
    const timer = setTimeout(() => {
      setSeen(target);
      markRead(target);
    }, MARK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [target]);
}
