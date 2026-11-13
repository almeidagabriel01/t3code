import { assistantIdFromThreadId } from "@t3tools/contracts";
import { decisionWaitsOnUser, requestWaitsOnUser } from "@t3tools/shared/needsUser";

/**
 * The sidebar's three zones (Needs you, Teams, Projects), derived once so web and mobile draw the
 * same rows and every indicator reads the same answer to "what waits on the user".
 */

export interface ZoneShell {
  readonly environmentId: string;
  readonly id: string;
  readonly archivedAt: string | null;
  readonly lineage: { readonly parentThreadId: string | null };
  readonly delegatedFrom?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  readonly pendingRequest?: {
    readonly id: string;
    readonly kind: string;
    readonly createdAt: string;
  } | null;
}

export type ThreadOwner =
  | {
      readonly kind: "assistant";
      /** `env:assistantId`. */
      readonly assistantKey: string;
      /** `env:teamId` when the thread is the assistant's thread for that group. */
      readonly teamKey: string | null;
    }
  | { readonly kind: "project" };

const PROJECT: ThreadOwner = { kind: "project" };
const MAX_DEPTH = 32;

const keyOf = (environmentId: string, id: string) => `${environmentId}:${id}`;

/**
 * Who started a thread: the assistant whose task it is, whose chat or group thread it is, or that
 * owns an ancestor it was delegated from. Everything else belongs to its project.
 */
export function threadOwnerResolver<S extends ZoneShell>(input: {
  readonly shells: ReadonlyArray<S>;
  /** `env:threadId` → `env:assistantId`, for tasks of active assistants (dismissed ones too). */
  readonly taskAssistantByThreadKey: ReadonlyMap<string, string>;
  /** `env:threadId` → `env:teamId`, for the group threads of active teams. */
  readonly teamKeyByThreadKey: ReadonlyMap<string, string>;
  /** `env:assistantId` of active assistants; an archived assistant's threads go back to projects. */
  readonly activeAssistantKeys: ReadonlySet<string>;
}): (shell: Pick<S, "environmentId" | "id">) => ThreadOwner {
  const byKey = new Map(input.shells.map((shell) => [keyOf(shell.environmentId, shell.id), shell]));
  const memo = new Map<string, ThreadOwner>();

  const direct = (environmentId: string, id: string): ThreadOwner | null => {
    const key = keyOf(environmentId, id);
    const task = input.taskAssistantByThreadKey.get(key);
    if (task !== undefined) return { kind: "assistant", assistantKey: task, teamKey: null };
    const assistantId = assistantIdFromThreadId(id);
    if (assistantId === null) return null;
    const assistantKey = keyOf(environmentId, assistantId);
    return input.activeAssistantKeys.has(assistantKey)
      ? { kind: "assistant", assistantKey, teamKey: input.teamKeyByThreadKey.get(key) ?? null }
      : PROJECT;
  };

  return (shell) => {
    const start = keyOf(shell.environmentId, shell.id);
    const cached = memo.get(start);
    if (cached !== undefined) return cached;
    let environmentId = shell.environmentId;
    let id = shell.id;
    let owner: ThreadOwner = PROJECT;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const found = direct(environmentId, id);
      if (found !== null) {
        owner = found;
        break;
      }
      const current = byKey.get(keyOf(environmentId, id));
      if (current === undefined) break;
      if (current.lineage.parentThreadId !== null) {
        id = current.lineage.parentThreadId;
      } else if (current.delegatedFrom != null) {
        environmentId = current.delegatedFrom.environmentId;
        id = current.delegatedFrom.threadId;
      } else {
        break;
      }
    }
    memo.set(start, owner);
    return owner;
  };
}

export type NeedsYouKind = "approval" | "question" | "decision";

export interface NeedsYouDecision {
  readonly id: string;
  readonly status: string;
  readonly fromThreadId: string;
  readonly createdAt: string;
  readonly notice?: true | undefined;
  readonly approvalRequestId?: string | undefined;
}

export interface NeedsYouItem<D extends NeedsYouDecision = NeedsYouDecision> {
  readonly key: string;
  readonly kind: NeedsYouKind;
  readonly environmentId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly owner: ThreadOwner;
  readonly request: { readonly id: string; readonly kind: string } | null;
  readonly decision: D | null;
}

/** Every pending request and open decision that waits on the user, oldest first. */
export function needsYouItems<S extends ZoneShell, D extends NeedsYouDecision>(input: {
  readonly shells: ReadonlyArray<S>;
  readonly decisions: ReadonlyArray<{ readonly environmentId: string; readonly decision: D }>;
  readonly ownerOf: (shell: Pick<S, "environmentId" | "id">) => ThreadOwner;
}): ReadonlyArray<NeedsYouItem<D>> {
  const items: Array<NeedsYouItem<D>> = [];
  for (const shell of input.shells) {
    const request = shell.pendingRequest;
    if (shell.archivedAt !== null || request == null || !requestWaitsOnUser(request.kind)) continue;
    items.push({
      key: `request:${shell.environmentId}:${request.id}`,
      kind: request.kind === "user_input" ? "question" : "approval",
      environmentId: shell.environmentId,
      threadId: shell.id,
      createdAt: request.createdAt,
      owner: input.ownerOf(shell),
      request: { id: request.id, kind: request.kind },
      decision: null,
    });
  }
  for (const { environmentId, decision } of input.decisions) {
    if (decision.status !== "open" || !decisionWaitsOnUser(decision)) continue;
    items.push({
      key: `decision:${environmentId}:${decision.id}`,
      kind: "decision",
      environmentId,
      threadId: decision.fromThreadId,
      createdAt: decision.createdAt,
      owner: input.ownerOf({ environmentId, id: decision.fromThreadId }),
      request: null,
      decision,
    });
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
}

export interface ZoneTeam {
  readonly environmentId: string;
  readonly team: { readonly id: string; readonly memberIds: ReadonlyArray<string> };
}

export interface ZoneAssistant {
  readonly environmentId: string;
  readonly assistant: { readonly id: string };
}

/**
 * Teams zone rows: each assistant once, in the first group (team order) that lists it, and the
 * rest in the ungrouped list. Input order is kept inside each list.
 */
export function teamsLayout<
  A extends { readonly entry: ZoneAssistant },
  T extends ZoneTeam,
>(input: {
  readonly assistants: ReadonlyArray<A>;
  readonly teams: ReadonlyArray<T>;
}): {
  readonly folders: ReadonlyArray<{ readonly team: T; readonly members: ReadonlyArray<A> }>;
  readonly ungrouped: ReadonlyArray<A>;
} {
  const byKey = new Map(
    input.assistants.map((item) => [
      keyOf(item.entry.environmentId, item.entry.assistant.id),
      item,
    ]),
  );
  const claimed = new Set<string>();
  const folders = input.teams.map((team) => {
    const memberKeys = new Set(team.team.memberIds.map((id) => keyOf(team.environmentId, id)));
    const members = input.assistants.filter((item) => {
      const key = keyOf(item.entry.environmentId, item.entry.assistant.id);
      if (!memberKeys.has(key) || claimed.has(key)) return false;
      claimed.add(key);
      return true;
    });
    return { team, members };
  });
  const ungrouped = [...byKey].flatMap(([key, item]) => (claimed.has(key) ? [] : [item]));
  return { folders, ungrouped };
}

export type ZoneIndicator =
  | { readonly kind: "needs"; readonly count: number }
  | { readonly kind: "failed" }
  | { readonly kind: "paused"; readonly count: number }
  | { readonly kind: "running"; readonly count: number }
  | { readonly kind: "unread"; readonly count: number };

type Mood = "idle" | "working" | "needs" | "failed";

/**
 * How many listed waits belong to these assistants or to this group's own threads. Rows and
 * folders count from the Needs you items, so an indicator never says "needs you" while the zone
 * is empty.
 */
export function countWaits(
  items: ReadonlyArray<{ readonly owner: ThreadOwner }>,
  scope: { readonly assistantKeys: ReadonlySet<string>; readonly teamKey?: string },
): number {
  return items.filter(
    ({ owner }) =>
      owner.kind === "assistant" &&
      (scope.assistantKeys.has(owner.assistantKey) ||
        (scope.teamKey !== undefined && owner.teamKey === scope.teamKey)),
  ).length;
}

/** An assistant row's one indicator: waits on you, failed, or working. */
export function assistantIndicator(input: {
  readonly needsYou: number;
  readonly mood: Mood;
}): ZoneIndicator | null {
  if (input.needsYou > 0) return { kind: "needs", count: input.needsYou };
  if (input.mood === "failed") return { kind: "failed" };
  if (input.mood === "working") return { kind: "running", count: 1 };
  return null;
}

/**
 * A group folder's one indicator, from the members drawn inside it and the group's own threads:
 * needs you, then failed, paused, running N, then unread messages.
 */
export function folderIndicator(input: {
  /** From `countWaits` over the drawn members and the group's key. */
  readonly needsYou: number;
  readonly members: ReadonlyArray<{ readonly mood: Mood }>;
  readonly chat: {
    readonly pausedTasks: number;
    readonly failedTasks: number;
    readonly unreadCount: number;
  } | null;
}): ZoneIndicator | null {
  if (input.needsYou > 0) return { kind: "needs", count: input.needsYou };
  if (
    (input.chat?.failedTasks ?? 0) > 0 ||
    input.members.some((member) => member.mood === "failed")
  )
    return { kind: "failed" };
  if ((input.chat?.pausedTasks ?? 0) > 0) return { kind: "paused", count: input.chat!.pausedTasks };
  const running = input.members.filter((member) => member.mood === "working").length;
  if (running > 0) return { kind: "running", count: running };
  if ((input.chat?.unreadCount ?? 0) > 0) return { kind: "unread", count: input.chat!.unreadCount };
  return null;
}
