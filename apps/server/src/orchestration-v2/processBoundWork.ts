import {
  type EventId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Open commands and tool calls; once the provider process that ran them is gone, nothing else ends them. */
export const processBoundTurnItems = (turnItems: ReadonlyArray<OrchestrationV2TurnItem>) =>
  pendingBackgroundTurnItems({ turnItems }).filter((item) => item.type !== "subagent");

export const endProcessBoundTurnItems = Effect.fnUntraced(function* <E>(input: {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Item nodes still open are ended with them; other nodes are ignored. */
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly status: "cancelled" | "failed" | "interrupted";
  readonly now: DateTime.Utc;
  readonly owner:
    | { readonly driver: ProviderDriverKind }
    | { readonly providerInstanceId: ProviderInstanceId };
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const itemNodeIds = new Set(input.items.map((item) => item.nodeId));
  for (const item of input.items) {
    events.push({
      ...input.owner,
      id: yield* input.allocateEventId(),
      type: "turn-item.updated",
      threadId: item.threadId,
      ...(item.runId === null ? {} : { runId: item.runId }),
      ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
      occurredAt: input.now,
      payload: { ...item, status: input.status, completedAt: input.now, updatedAt: input.now },
    });
  }
  for (const node of input.nodes) {
    if (!itemNodeIds.has(node.id) || !isOrchestrationV2WorkActive(node.status)) continue;
    events.push({
      ...input.owner,
      id: yield* input.allocateEventId(),
      type: "node.updated",
      threadId: node.threadId,
      ...(node.runId === null ? {} : { runId: node.runId }),
      nodeId: node.id,
      occurredAt: input.now,
      payload: { ...node, status: input.status, completedAt: input.now },
    });
  }
  return events;
});
