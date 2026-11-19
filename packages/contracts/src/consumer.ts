import * as Schema from "effect/Schema";

import { assistantIdFromThreadId, AssistantId, AssistantTeamId } from "./assistants.ts";
import { isAssistantGroupThreadId } from "./assistantGroups.ts";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationV2AppThread, OrchestrationV2DelegatedFrom } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Who spends a provider's turns and a machine's processes: the key usage, limits and resources share. */
const ConsumerBase = {
  threadId: ThreadId,
  /** The machine the thread runs on. */
  environmentId: EnvironmentId,
  /** The provider instance, which carries the account. */
  providerInstanceId: ProviderInstanceId,
};

export const ConsumerRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), ...ConsumerBase }),
  Schema.Struct({ kind: Schema.Literal("assistant"), ...ConsumerBase, assistantId: AssistantId }),
  Schema.Struct({
    kind: Schema.Literal("groupMember"),
    ...ConsumerBase,
    assistantId: AssistantId,
    /** Null when the caller has no group table: the thread id only holds a hash of the group id. */
    groupId: Schema.NullOr(AssistantTeamId),
  }),
  Schema.Struct({
    kind: Schema.Literal("subagent"),
    ...ConsumerBase,
    parentThreadId: ThreadId,
    /** A task delegated from a linked environment answers to a parent on that machine. */
    parentEnvironmentId: EnvironmentId,
  }),
]);
export type ConsumerRef = typeof ConsumerRef.Type;
export type ConsumerKind = ConsumerRef["kind"];

export function consumerRefFromThread(
  thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "providerInstanceId"> & {
    // MCP-launched threads store `delegatedFrom: null` at runtime, and clients keep it as null.
    readonly delegatedFrom?: OrchestrationV2DelegatedFrom | null | undefined;
  },
  environmentId: EnvironmentId,
  groupId: AssistantTeamId | null = null,
): ConsumerRef {
  const base = {
    threadId: thread.id,
    environmentId,
    providerInstanceId: thread.providerInstanceId,
  };
  const assistantId = assistantIdFromThreadId(thread.id);
  if (assistantId !== null) {
    return isAssistantGroupThreadId(thread.id)
      ? { kind: "groupMember", ...base, assistantId: AssistantId.make(assistantId), groupId }
      : { kind: "assistant", ...base, assistantId: AssistantId.make(assistantId) };
  }
  const { parentThreadId, relationshipToParent } = thread.lineage;
  if (relationshipToParent === "subagent" && parentThreadId !== null) {
    return { kind: "subagent", ...base, parentThreadId, parentEnvironmentId: environmentId };
  }
  const { delegatedFrom } = thread;
  if (delegatedFrom != null) {
    return {
      kind: "subagent",
      ...base,
      parentThreadId: delegatedFrom.threadId,
      parentEnvironmentId: delegatedFrom.environmentId,
    };
  }
  return { kind: "thread", ...base };
}
