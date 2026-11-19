import type { ThreadOwner, ZoneShell } from "./sidebarZones.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { resolveSidebarThreadStatus, sidebarStatusIsRunning } from "./state/threadAttention.ts";

// ponytail: local stand-in for contracts' `ConsumerRef`; swap the type when it lands.
export interface WorkingConsumer {
  readonly kind: "thread" | "assistant" | "groupMember" | "subagent";
  /** The machine the work runs on: the running thread's own environment. */
  readonly environmentId: string;
  /** Null for a group member the server reports running before its thread reaches this client. */
  readonly threadId: string | null;
  readonly assistantId: string | null;
  readonly groupId: string | null;
  readonly parentThreadId: string | null;
  readonly providerInstanceId: string | null;
}

export type WorkingShell = ZoneShell &
  Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
    | "createdAt"
    | "sideChatOf"
  > & {
    readonly lineage: {
      readonly parentThreadId: string | null;
      readonly relationshipToParent?: string | null | undefined;
    };
    readonly latestRun: { readonly startedAt?: string | null | undefined } | null;
    readonly modelSelection: { readonly instanceId: string };
  };

const idAfterEnvironment = (key: string) => key.slice(key.indexOf(":") + 1);

/** Who a thread's work belongs to, from its lineage and `threadOwnerResolver`'s owner. */
export function consumerOfThread(shell: WorkingShell, owner: ThreadOwner): WorkingConsumer {
  const assistantId = owner.kind === "assistant" ? idAfterEnvironment(owner.assistantKey) : null;
  const groupId =
    owner.kind === "assistant" && owner.teamKey !== null ? idAfterEnvironment(owner.teamKey) : null;
  // Work a linked environment runs for a thread lists under that thread, as a subagent does.
  const parentThreadId =
    shell.lineage.relationshipToParent === "subagent"
      ? shell.lineage.parentThreadId
      : (shell.delegatedFrom?.threadId ?? null);
  return {
    kind:
      parentThreadId !== null
        ? "subagent"
        : groupId !== null
          ? "groupMember"
          : assistantId !== null
            ? "assistant"
            : "thread",
    environmentId: shell.environmentId,
    threadId: shell.id,
    assistantId,
    groupId,
    parentThreadId,
    providerInstanceId: shell.runtime?.providerInstanceId ?? shell.modelSelection.instanceId,
  };
}

export interface WorkingItem<S extends WorkingShell = WorkingShell> {
  readonly key: string;
  readonly consumer: WorkingConsumer;
  /** Null for a member known only from `runningMemberIds`. */
  readonly shell: S | null;
}

/**
 * Work the project lists do not show as a row of its own: assistants, group members and
 * subagents that run now, newest first. Work waiting on the user is a Needs you item instead.
 */
export function workingItems<S extends WorkingShell>(input: {
  readonly shells: ReadonlyArray<S>;
  readonly ownerOf: (shell: Pick<S, "environmentId" | "id">) => ThreadOwner;
  readonly teams: ReadonlyArray<{
    readonly environmentId: string;
    readonly team: {
      readonly id: string;
      readonly chat?: { readonly runningMemberIds?: ReadonlyArray<string> } | null | undefined;
    };
  }>;
}): ReadonlyArray<WorkingItem<S>> {
  const items: Array<WorkingItem<S> & { readonly at: string }> = [];
  const covered = new Set<string>();
  for (const shell of input.shells) {
    if (shell.archivedAt !== null || shell.sideChatOf != null) continue;
    if (!sidebarStatusIsRunning(resolveSidebarThreadStatus(shell))) continue;
    const consumer = consumerOfThread(shell, input.ownerOf(shell));
    if (consumer.kind === "thread") continue;
    if (consumer.groupId !== null) {
      covered.add(`${shell.environmentId}:${consumer.groupId}:${consumer.assistantId}`);
    }
    items.push({
      key: `${shell.environmentId}:${shell.id}`,
      consumer,
      shell,
      at: shell.latestRun?.startedAt ?? shell.createdAt,
    });
  }
  // Older servers send no `runningMemberIds`; their members show only through their threads.
  for (const { environmentId, team } of input.teams) {
    for (const assistantId of team.chat?.runningMemberIds ?? []) {
      if (covered.has(`${environmentId}:${team.id}:${assistantId}`)) continue;
      items.push({
        key: `member:${environmentId}:${team.id}:${assistantId}`,
        consumer: {
          kind: "groupMember",
          environmentId,
          threadId: null,
          assistantId,
          groupId: team.id,
          parentThreadId: null,
          providerInstanceId: null,
        },
        shell: null,
        at: "",
      });
    }
  }
  return items
    .sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key))
    .map(({ at: _at, ...item }) => item);
}

/**
 * The line every client shows under a working row: who works and on which machine, such as
 * "Ada · Backend · MacBook" or "Subagent of Fix login · VPS".
 */
export function workingConsumerLine(
  consumer: WorkingConsumer,
  names: {
    readonly assistant: (environmentId: string, assistantId: string) => string | undefined;
    readonly group: (environmentId: string, groupId: string) => string | undefined;
    readonly thread: (environmentId: string, threadId: string) => string | undefined;
    readonly environment: (environmentId: string) => string | undefined;
  },
): string {
  const { environmentId } = consumer;
  const assistant =
    consumer.assistantId === null
      ? undefined
      : (names.assistant(environmentId, consumer.assistantId) ?? "Assistant");
  const group =
    consumer.groupId === null
      ? undefined
      : (names.group(environmentId, consumer.groupId) ?? "Group");
  const who =
    consumer.kind === "subagent"
      ? `Subagent of ${
          assistant ??
          (consumer.parentThreadId === null
            ? undefined
            : names.thread(environmentId, consumer.parentThreadId)) ??
          "a thread"
        }`
      : assistant;
  return [who, consumer.kind === "subagent" ? undefined : group, names.environment(environmentId)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

export type WorkingNames = Parameters<typeof workingConsumerLine>[1];

export interface WorkingRow<S extends WorkingShell & { readonly title: string }> {
  readonly item: WorkingItem<S>;
  /** The thread's title; a member known only from `runningMemberIds` reads as its group's task. */
  readonly title: string;
  readonly line: string;
}

/** Working rows as every client draws them, in `workingItems` order. */
export function workingRows<S extends WorkingShell & { readonly title: string }>(
  items: ReadonlyArray<WorkingItem<S>>,
  names: WorkingNames,
): ReadonlyArray<WorkingRow<S>> {
  return items.map((item) => ({
    item,
    title: item.shell?.title ?? "Group task",
    line: workingConsumerLine(item.consumer, names),
  }));
}
