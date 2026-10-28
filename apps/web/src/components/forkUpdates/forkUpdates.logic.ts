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
