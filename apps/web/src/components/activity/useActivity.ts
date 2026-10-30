import { useLocation, useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useDelegatedUnderParent, useThreadShells } from "../../state/entities";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useUiStateStore } from "../../uiStateStore";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { buildActivityEntries, countActivityBadge } from "./activity.logic";

const NO_HOLDS = new Map<string, never>();
const NO_RELEASES: ReadonlySet<string> = new Set();

/** Threads that need the user or finished unseen, for the bell and rail badges. */
export function useActivityBadge(): number {
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const now = useNowMinute();
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  return countActivityBadge(
    buildActivityEntries({
      threads,
      delegatedUnderParent,
      localLastVisitedAtByKey,
      holds: NO_HOLDS,
      releases: NO_RELEASES,
      now,
      openDecisionThreadKeys,
    }),
  );
}

export function useActivityOpen(): boolean {
  return useLocation({ select: (location) => location.pathname === "/activity" });
}

/** Opens the Activity page, or leaves it for the view it was opened over. */
export function useToggleActivity() {
  const open = useActivityOpen();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  return () => void (open ? navigateToMainApp() : navigate({ to: "/activity" }));
}
