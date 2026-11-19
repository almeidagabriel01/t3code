import { useLocation, useNavigate } from "@tanstack/react-router";

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useDelegatedUnderParent, useThreadShells } from "../../state/entities";
import { useOpenDecisionAtByThreadKey, useOpenDecisionThreadKeys } from "../../state/decisions";
import { useEnvironmentsWithScope } from "../../state/session";
import { useUiStateStore } from "../../uiStateStore";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { buildActivityEntries, countActivityBadge } from "./activity.logic";

const NO_HOLDS = new Map<string, never>();
const NO_RELEASES: ReadonlySet<string> = new Set();

/** Activity's rows with no page holds, so a read thread leaves at once. */
export function useActivityEntries() {
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const now = useNowMinute();
  const openDecisionThreadKeys = useOpenDecisionThreadKeys();
  const openDecisionAtByKey = useOpenDecisionAtByThreadKey();
  return buildActivityEntries({
    threads,
    delegatedUnderParent,
    localLastVisitedAtByKey,
    holds: NO_HOLDS,
    releases: NO_RELEASES,
    now,
    openDecisionThreadKeys,
    openDecisionAtByKey,
  });
}

/** Rows that need the user or finished since they last looked, for the bell and rail badges. */
export function useActivityBadge(): number {
  const entries = useActivityEntries();
  const operable = useEnvironmentsWithScope(
    entries.map((entry) => entry.thread),
    AuthOrchestrationOperateScope,
  );
  return countActivityBadge(entries, (thread) => operable.has(thread.environmentId));
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
