import {
  type EventId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";
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

type SubagentProjection = Pick<
  OrchestrationV2ThreadProjection,
  "nodes" | "subagents" | "turnItems"
>;
type NativeSubagentRef = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>,
  "subagentId" | "origin" | "childThreadId" | "providerInstanceId"
>;

/**
 * A native subagent dies with its process: end its record, its own thread's runless root turn,
 * and the subagents it started there, which a provider can record on that thread rather than this one.
 */
export const endNativeSubagentTree = Effect.fnUntraced(function* <E>(input: {
  readonly projection: SubagentProjection;
  readonly subagent: NativeSubagentRef;
  readonly status: "cancelled" | "failed" | "interrupted";
  readonly now: DateTime.Utc;
  readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
  /** Shared across calls so a child thread is ended once. */
  readonly visitedChildThreadIds: Set<ThreadId>;
  readonly readChild: (
    threadId: ThreadId,
  ) => Effect.Effect<
    (SubagentProjection & Pick<OrchestrationV2ThreadProjection, "providerTurns">) | null,
    E
  >;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const dying = [{ projection: input.projection, subagent: input.subagent }];
  for (const { projection, subagent } of dying) {
    events.push(
      ...(yield* endOrphanedNativeSubagent({
        projection,
        subagentId: subagent.subagentId,
        status: input.status,
        now: input.now,
        emitted: [...input.emitted, ...events],
        allocateEventId: input.allocateEventId,
      })),
    );
    const childThreadId = subagent.childThreadId;
    if (
      subagent.origin !== "provider_native" ||
      childThreadId === null ||
      input.visitedChildThreadIds.has(childThreadId)
    ) {
      continue;
    }
    input.visitedChildThreadIds.add(childThreadId);
    const child = yield* input.readChild(childThreadId);
    if (child === null) continue;
    events.push(
      ...(yield* endRunlessRootTurns({
        threadId: childThreadId,
        providerInstanceId: subagent.providerInstanceId,
        projection: child,
        status: input.status,
        now: input.now,
        emitted: [...input.emitted, ...events],
        allocateEventId: input.allocateEventId,
      })),
    );
    for (const nested of child.turnItems) {
      if (nested.type === "subagent") dying.push({ projection: child, subagent: nested });
    }
    for (const nested of child.subagents) {
      if (nested.origin === "provider_native" && nested.runId === null) {
        dying.push({
          projection: child,
          subagent: {
            subagentId: nested.id,
            origin: nested.origin,
            childThreadId: nested.childThreadId,
            providerInstanceId: nested.providerInstanceId,
          },
        });
      }
    }
  }
  return events;
});
