import type {
  MemoryTaskGrantCeiling,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { continuationOrigin } from "./ContinuationChain.ts";

/**
 * The memory ceiling a run's provider session is prepared with. An ordinary start (the person typing
 * in web or mobile) carries no ceiling, so current policy alone decides; everything else is bound
 * by the ceiling the server captured when the work was created, and a broken chain gets none.
 */
export function runMemoryPrepareInput(input: {
  readonly run: OrchestrationV2Run;
  readonly message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "scheduledTaskId"
  >;
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
}): { readonly memoryGrantCeiling: MemoryTaskGrantCeiling | null } {
  const origin = continuationOrigin(input);
  if (origin === undefined) return { memoryGrantCeiling: "none" };
  const { run, message } = origin;
  const ordinary =
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile") &&
    message.scheduledTaskId === undefined &&
    run.delegatedTaskId === undefined;
  return { memoryGrantCeiling: ordinary ? null : (run.memoryGrantCeiling ?? "none") };
}
