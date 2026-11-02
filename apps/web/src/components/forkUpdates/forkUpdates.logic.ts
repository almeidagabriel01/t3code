import type { ForkUpdateStatus } from "@t3tools/contracts";

/** A release tag upstream that the fork has not merged yet and the user has not dismissed. */
export function shouldNotifyForkUpdate(
  status: Pick<ForkUpdateStatus, "available" | "behind" | "headTag" | "upstreamTag">,
  dismissedTag: string,
): boolean {
  return (
    status.available &&
    status.behind > 0 &&
    status.upstreamTag !== null &&
    status.upstreamTag !== status.headTag &&
    status.upstreamTag !== dismissedTag
  );
}

export type ForkUpdateAction = "none" | "add-project" | "update" | "resolve";

/** The one action that moves the fork forward: a conflicting merge needs the agent, a clean one just runs. */
export function forkUpdateAction(
  status: Pick<ForkUpdateStatus, "available" | "behind" | "wouldConflict">,
  hasProject: boolean,
): ForkUpdateAction {
  if (!status.available || status.behind === 0) return "none";
  if (!hasProject) return "add-project";
  return status.wouldConflict === true ? "resolve" : "update";
}
