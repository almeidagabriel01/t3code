import {
  assistantIdFromThreadId,
  isAssistantGroupThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ResourceTelemetryConsumer,
  type ResourceTelemetryOwner,
  type ResourceTelemetryProcess,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

/** Who an agent process works for. `groupId` comes from the group thread tables: the id only hashes it. */
export function consumerOf(input: {
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    "id" | "lineage" | "providerInstanceId" | "delegatedFrom"
  >;
  readonly groupId: string | null;
  readonly environmentId: EnvironmentId;
}): ResourceTelemetryConsumer {
  const { thread, groupId, environmentId } = input;
  const base = {
    threadId: thread.id,
    environmentId,
    providerInstanceId: thread.providerInstanceId,
  };
  const assistantId = assistantIdFromThreadId(thread.id);
  if (assistantId !== null && isAssistantGroupThreadId(thread.id)) {
    return { ...base, kind: "groupMember", assistantId, ...(groupId === null ? {} : { groupId }) };
  }
  if (assistantId !== null) return { ...base, kind: "assistant", assistantId };
  // A task delegated from a linked environment answers to a parent on that machine.
  const parentThreadId =
    thread.delegatedFrom?.threadId ??
    (thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null);
  if (parentThreadId !== null) return { ...base, kind: "subagent", parentThreadId };
  return { ...base, kind: "thread" };
}

/**
 * Tags each agent owner with its consumer. `cache` keeps one lookup per live pid and forgets
 * owners that left; an owner whose thread cannot be read stays listed, untagged, and retries.
 */
export const withConsumers = Effect.fnUntraced(function* <E, R>(
  owners: ReadonlyArray<ResourceTelemetryOwner>,
  cache: Map<string, ResourceTelemetryConsumer>,
  resolve: (threadId: ThreadId) => Effect.Effect<ResourceTelemetryConsumer | null, E, R>,
) {
  const live = new Set<string>();
  const tagged: Array<ResourceTelemetryOwner> = [];
  for (const owner of owners) {
    if (owner.kind !== "agent") {
      tagged.push(owner);
      continue;
    }
    const key = `${owner.pid}:${owner.threadId}`;
    live.add(key);
    let consumer = cache.get(key);
    if (consumer === undefined) {
      consumer =
        (yield* resolve(ThreadId.make(owner.threadId)).pipe(Effect.orElseSucceed(() => null))) ??
        undefined;
      if (consumer !== undefined) cache.set(key, consumer);
    }
    tagged.push(consumer === undefined ? owner : { ...owner, consumer });
  }
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  return tagged;
});
