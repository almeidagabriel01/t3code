import {
  AssistantId,
  AssistantTeamId,
  consumerRefFromThread,
  type ConsumerRef,
  type EnvironmentId,
} from "@t3tools/contracts";

import type { ThreadOwner } from "./sidebarZones.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { resolveSidebarThreadStatus, sidebarStatusIsRunning } from "./state/threadAttention.ts";

export type WorkingShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "providerInstanceId"
  | "lineage"
  | "delegatedFrom"
  | "archivedAt"
  | "sideChatOf"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
  | "createdAt"
  | "title"
> & { readonly latestRun: { readonly startedAt?: string | null | undefined } | null };

/** A group member the server reports running before its thread reaches this client. */
export interface PendingMember {
  readonly kind: "groupMember";
  readonly threadId: null;
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly groupId: AssistantTeamId;
}

const idAfterEnvironment = (key: string) => key.slice(key.indexOf(":") + 1);

/**
 * `consumerRefFromThread`, told who owns the thread: an assistant's launched task and its work
 * routed to a linked machine are the assistant's; its local subagents stay subagents.
 */
function consumerOf(shell: WorkingShell, owner: ThreadOwner): ConsumerRef {
  const groupId =
    owner.kind === "assistant" && owner.teamKey !== null
      ? AssistantTeamId.make(idAfterEnvironment(owner.teamKey))
      : null;
  const ref = consumerRefFromThread(shell, shell.environmentId, groupId);
  const localSubagent = ref.kind === "subagent" && ref.parentEnvironmentId === ref.environmentId;
  if (owner.kind !== "assistant" || localSubagent) return ref;
  const { threadId, environmentId, providerInstanceId } = ref;
  const base = { threadId, environmentId, providerInstanceId };
  const assistantId = AssistantId.make(idAfterEnvironment(owner.assistantKey));
  return groupId === null
    ? { kind: "assistant", ...base, assistantId }
    : { kind: "groupMember", ...base, assistantId, groupId };
}

export interface WorkingItem<S extends WorkingShell = WorkingShell> {
  readonly key: string;
  readonly consumer: ConsumerRef | PendingMember;
  /** The assistant whose work this is, also for its subagents; null for a project's. */
  readonly ownerAssistantId: AssistantId | null;
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
    readonly environmentId: EnvironmentId;
    readonly team: {
      readonly id: AssistantTeamId;
      readonly chat?: { readonly runningMemberIds?: ReadonlyArray<AssistantId> } | null | undefined;
    };
  }>;
}): ReadonlyArray<WorkingItem<S>> {
  const items: Array<WorkingItem<S> & { readonly at: string }> = [];
  const covered = new Set<string>();
  for (const shell of input.shells) {
    if (shell.archivedAt !== null || shell.sideChatOf != null) continue;
    const owner = input.ownerOf(shell);
    const consumer = consumerOf(shell, owner);
    if (consumer.kind === "thread") continue;
    // A member whose thread waits on the user is a Needs you item, not a second working row.
    if (consumer.kind === "groupMember") {
      covered.add(`${shell.environmentId}:${consumer.groupId}:${consumer.assistantId}`);
    }
    if (!sidebarStatusIsRunning(resolveSidebarThreadStatus(shell))) continue;
    items.push({
      key: `${shell.environmentId}:${shell.id}`,
      consumer,
      ownerAssistantId:
        owner.kind === "assistant"
          ? AssistantId.make(idAfterEnvironment(owner.assistantKey))
          : null,
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
        },
        ownerAssistantId: assistantId,
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
  item: Pick<WorkingItem, "consumer" | "ownerAssistantId">,
  names: {
    readonly assistant: (environmentId: string, assistantId: string) => string | undefined;
    readonly group: (environmentId: string, groupId: string) => string | undefined;
    readonly thread: (environmentId: string, threadId: string) => string | undefined;
    readonly environment: (environmentId: string) => string | undefined;
  },
): string {
  const { consumer } = item;
  const { environmentId } = consumer;
  const assistant =
    item.ownerAssistantId === null
      ? undefined
      : (names.assistant(environmentId, item.ownerAssistantId) ?? "Assistant");
  const who =
    consumer.kind === "subagent"
      ? `Subagent of ${assistant ?? names.thread(consumer.parentEnvironmentId, consumer.parentThreadId) ?? "a thread"}`
      : assistant;
  const group =
    consumer.kind === "groupMember"
      ? consumer.groupId === null
        ? "Group"
        : (names.group(environmentId, consumer.groupId) ?? "Group")
      : undefined;
  return [who, group, names.environment(environmentId)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

type WorkingNames = Parameters<typeof workingConsumerLine>[1];

export interface WorkingRow<S extends WorkingShell> {
  readonly item: WorkingItem<S>;
  /** The thread's title; a member known only from `runningMemberIds` reads as its group's task. */
  readonly title: string;
  readonly line: string;
}

/** Working rows as every client draws them, in `workingItems` order. */
export function workingRows<S extends WorkingShell>(
  items: ReadonlyArray<WorkingItem<S>>,
  names: WorkingNames,
): ReadonlyArray<WorkingRow<S>> {
  return items.map((item) => ({
    item,
    title: item.shell?.title ?? "Group task",
    line: workingConsumerLine(item, names),
  }));
}
