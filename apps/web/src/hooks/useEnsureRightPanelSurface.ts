import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useRightPanelStore } from "../rightPanelStore";

export function useEnsureRightPanelSurface(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly open: boolean;
  readonly hasActiveSurface: boolean;
  readonly filesAvailable: boolean;
  readonly diffAvailable: boolean;
}) {
  const { threadRef, open, hasActiveSurface, filesAvailable, diffAvailable } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an open panel must always show a surface, and the store owns which one
  useEffect(() => {
    if (!threadRef || !open || hasActiveSurface || !filesAvailable) return;
    const { lastFixedKind, ensureActiveSurface } = useRightPanelStore.getState();
    ensureActiveSurface(
      threadRef,
      lastFixedKind === "diff" && !diffAvailable ? "files" : lastFixedKind,
    );
  }, [threadRef, open, hasActiveSurface, filesAvailable, diffAvailable]);
}
