import { useEffect, useEffectEvent, useState } from "react";

const MARK_DELAY_MS = 500;

function windowIsViewed() {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Tells the server how far the user has read once the newest message has been in view for a
 * moment: the chat is open, the window is focused and the feed is scrolled to its end.
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
  // Marked as unread from the menu while open stays unread until something newer arrives.
  const [sent, setSent] = useState(0);
  const [viewed, setViewed] = useState(windowIsViewed);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window focus is browser state
  useEffect(() => {
    const update = () => setViewed(windowIsViewed());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const target =
    enabled && viewed && atBottom && latestSeq !== null && latestSeq > readSeq && latestSeq > sent
      ? latestSeq
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that reports to the server
  useEffect(() => {
    if (target === null) return;
    const timer = setTimeout(() => {
      setSent(target);
      markRead(target);
    }, MARK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [target]);
}
