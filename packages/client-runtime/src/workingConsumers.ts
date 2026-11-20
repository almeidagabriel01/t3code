import {
  AssistantId,
  AssistantTeamId,
  consumerRefFromThread,
  type ConsumerRef,
  type EnvironmentId,
} from "@t3tools/contracts";

import type { ThreadOwner } from "./sidebarZones.ts";
import { threadProviderInstanceId, type EnvironmentThreadShell } from "./state/models.ts";
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
  | "projectId"
  | "modelSelection"
  | "deletedAt"
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
 * routed to a linked machine are the assistant's, and a linked machine's task for a project
 * thread lists under that thread, as a subagent does.
 */
function consumerOf(shell: WorkingShell, owner: ThreadOwner): ConsumerRef {
  const groupId =
    owner.kind === "assistant" && owner.teamKey !== null
      ? AssistantTeamId.make(idAfterEnvironment(owner.teamKey))
      : null;
  // The account the usage bar files this thread under, so each account's working is a subset.
  const ref = {
    ...consumerRefFromThread(shell, shell.environmentId, groupId),
    providerInstanceId: threadProviderInstanceId(shell),
  };
  const { threadId, environmentId, providerInstanceId } = ref;
  const base = { threadId, environmentId, providerInstanceId };
  if (ref.kind === "subagent") return ref;
  if (owner.kind === "assistant") {
    const assistantId = AssistantId.make(idAfterEnvironment(owner.assistantKey));
    return groupId === null
      ? { kind: "assistant", ...base, assistantId }
      : { kind: "groupMember", ...base, assistantId, groupId };
  }
  return shell.delegatedFrom == null
    ? ref
    : { kind: "subagent", ...base, parentThreadId: shell.delegatedFrom.threadId };
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
 * Whether `workingItems` lists this thread. Working: a turn is in progress (starting, running,
 * waiting on its children or on background work) and nothing waits on the user. A merely live
 * provider session, Needs you (approval, answer, decision), deleted, archived and side chats
 * are not.
 */
export function isWorkingShell(
  shell: Pick<
    WorkingShell,
    | "environmentId"
    | "id"
    | "archivedAt"
    | "sideChatOf"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
    | "deletedAt"
  >,
  openDecisionThreadKeys: ReadonlySet<string>,
): boolean {
  return (
    shell.deletedAt === null &&
    shell.archivedAt === null &&
    shell.sideChatOf == null &&
    !openDecisionThreadKeys.has(`${shell.environmentId}:${shell.id}`) &&
    sidebarStatusIsRunning(resolveSidebarThreadStatus(shell))
  );
}

/**
 * Everything working now, the one set every count and list of working agents reads: project
 * threads, assistants, group members and subagents (`isWorkingShell`), newest first. Feed it
 * every thread, tag-hidden ones included: a hidden agent still works.
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
  /** Scoped thread keys with an open decision (`openDecisionThreadKeys`); those need the user. */
  readonly openDecisionThreadKeys: ReadonlySet<string>;
}): ReadonlyArray<WorkingItem<S>> {
  const items: Array<WorkingItem<S> & { readonly at: string }> = [];
  const covered = new Set<string>();
  for (const shell of input.shells) {
    if (shell.deletedAt !== null || shell.archivedAt !== null || shell.sideChatOf != null) continue;
    const key = `${shell.environmentId}:${shell.id}`;
    const owner = input.ownerOf(shell);
    const consumer = consumerOf(shell, owner);
    // A member whose thread waits on the user is a Needs you item, not a second working row.
    if (consumer.kind === "groupMember") {
      covered.add(`${shell.environmentId}:${consumer.groupId}:${consumer.assistantId}`);
    }
    if (!isWorkingShell(shell, input.openDecisionThreadKeys)) continue;
    items.push({
      key,
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

/** Keys of the working threads, for surfaces that mark threads; members known by name have none. */
export function workingThreadKeys(items: ReadonlyArray<WorkingItem>): ReadonlySet<string> {
  return new Set(items.flatMap((item) => (item.shell === null ? [] : [item.key])));
}

/**
 * The line every client shows under a working row: who works and on which machine, such as
 * "Ada · Backend · MacBook", "Subagent of Fix login · VPS" or "Website · MacBook".
 */
export function workingConsumerLine(
  item: Pick<WorkingItem, "consumer" | "ownerAssistantId" | "shell">,
  names: {
    readonly assistant: (environmentId: string, assistantId: string) => string | undefined;
    readonly group: (environmentId: string, groupId: string) => string | undefined;
    readonly thread: (environmentId: string, threadId: string) => string | undefined;
    readonly project: (environmentId: string, projectId: string) => string | undefined;
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
      ? `Subagent of ${assistant ?? names.thread(environmentId, consumer.parentThreadId) ?? "a thread"}`
      : consumer.kind === "thread" && item.shell !== null
        ? names.project(environmentId, item.shell.projectId)
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
