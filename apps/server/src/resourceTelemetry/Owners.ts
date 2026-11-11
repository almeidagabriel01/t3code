import type { ResourceTelemetryOwner, ResourceTelemetryProcess } from "@t3tools/contracts";
import type { ProcessOwner } from "@t3tools/shared/ProcessOwners";

/** Owners whose process is still in the table; the newest registration wins a repeated pid. */
export function liveOwners(
  registered: ReadonlyArray<ProcessOwner>,
  processes: ReadonlyArray<Pick<ResourceTelemetryProcess, "identity">>,
): ReadonlyArray<ResourceTelemetryOwner> {
  const live = new Set(processes.map((process) => process.identity.pid));
  const byPid = new Map<number, ResourceTelemetryOwner>();
  for (const owner of registered) {
    if (owner.kind !== "terminal" && live.has(owner.pid)) byPid.set(owner.pid, owner);
  }
  return [...byPid.values()];
}
