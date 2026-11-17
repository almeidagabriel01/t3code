import {
  assistantIdFromThreadId,
  type AssistantTeamChat,
  type ProjectId,
} from "@t3tools/contracts";
import {
  decisionWaitsOnUser,
  guestWaitsOnUser,
  requestWaitsOnUser,
} from "@t3tools/shared/needsUser";

import {
  assistantGroupChatWaiting,
  assistantGroupProjectLabel,
  assistantGroupTabKey,
  assistantGroupWaitingWhy,
  type AssistantGroupTabKey,
} from "./assistantGroupChat.ts";
import { sortByAttention, type AttentionKey } from "./attentionOrder.ts";
import type { AssistantWorkSite } from "./assistantLiveWork.ts";
import {
  assistantPresence,
  assistantPresenceOf,
  type AssistantMood,
  type AssistantPresence,
} from "./assistantRobot.ts";

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
  readonly pendingGuestMessageCount?: number | undefined;
  /** Required so every caller passes a shell from `presentThreadShell`, which fills it. */
  readonly oldestPendingGuestMessageAt: string | null;
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

/** The Needs you card for guest messages waiting on the owner, on web and mobile. */
export const GUEST_WAITING_LABEL = "Guest waiting";

export interface NeedsYouDecision {
  readonly id: string;
  readonly status: string;
  readonly fromThreadId: string;
  readonly createdAt: string;
  readonly notice?: true | undefined;
  readonly approvalRequestId?: string | undefined;
  readonly title?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export type NeedsYouItem<D extends NeedsYouDecision = NeedsYouDecision> = {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  /** Null for a waiting guest whose time is unknown; it lists last. */
  readonly createdAt: string | null;
  readonly owner: ThreadOwner;
} & (
  | {
      readonly kind: "approval" | "question";
      readonly request: { readonly id: string; readonly kind: string };
    }
  | { readonly kind: "decision"; readonly decision: D }
  | { readonly kind: "guest" }
);

export type NeedsYouKind = NeedsYouItem["kind"];

/** Every pending request, waiting guest and open decision that waits on the user, oldest first. */
export function needsYouItems<S extends ZoneShell, D extends NeedsYouDecision>(input: {
  readonly shells: ReadonlyArray<S>;
  readonly decisions: ReadonlyArray<{ readonly environmentId: string; readonly decision: D }>;
  readonly ownerOf: (shell: Pick<S, "environmentId" | "id">) => ThreadOwner;
}): ReadonlyArray<NeedsYouItem<D>> {
  const items: Array<NeedsYouItem<D>> = [];
  for (const shell of input.shells) {
    if (shell.archivedAt !== null) continue;
    const request = shell.pendingRequest;
    if (request != null && requestWaitsOnUser(request.kind)) {
      items.push({
        key: `request:${shell.environmentId}:${request.id}`,
        kind: request.kind === "user_input" ? "question" : "approval",
        environmentId: shell.environmentId,
        threadId: shell.id,
        createdAt: request.createdAt,
        owner: input.ownerOf(shell),
        request: { id: request.id, kind: request.kind },
      });
    }
    if (guestWaitsOnUser(shell)) {
      items.push({
        key: `guest:${shell.environmentId}:${shell.id}`,
        kind: "guest",
        environmentId: shell.environmentId,
        threadId: shell.id,
        createdAt: shell.oldestPendingGuestMessageAt,
        owner: input.ownerOf(shell),
      });
    }
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
      decision,
    });
  }
  return items.sort(
    (a, b) => compareOldestFirst(a.createdAt, b.createdAt) || a.key.localeCompare(b.key),
  );
}

/** Oldest first; an unknown time counts as the newest. */
function compareOldestFirst(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b);
}

/** A wait that expires within this window is drawn as urgent. */
const NEEDS_YOU_DUE_SOON_MS = 60 * 60 * 1000;

export type NeedsYouDue = { readonly at: string; readonly soon: boolean } | null;

/** When a wait expires, and whether that is under an hour away (or past); null without a deadline. */
export function needsYouDue(expiresAt: string | null | undefined, nowMs: number): NeedsYouDue {
  if (expiresAt == null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return { at: expiresAt, soon: at - nowMs < NEEDS_YOU_DUE_SOON_MS };
}

/** Who asks, for the card's first line: a group, an assistant, or the thread itself. */
export type NeedsYouFrom =
  | { readonly kind: "group"; readonly teamKey: string; readonly assistantKey: string }
  | { readonly kind: "assistant"; readonly assistantKey: string }
  | { readonly kind: "thread" };

const needsYouFrom = (owner: ThreadOwner): NeedsYouFrom =>
  owner.kind === "project"
    ? { kind: "thread" }
    : owner.teamKey === null
      ? { kind: "assistant", assistantKey: owner.assistantKey }
      : { kind: "group", teamKey: owner.teamKey, assistantKey: owner.assistantKey };

export type NeedsYouCard<D extends NeedsYouDecision = NeedsYouDecision> = NeedsYouItem<D> & {
  readonly from: NeedsYouFrom;
  /** The decision's own title; null for a request or a guest, which the client titles itself. */
  readonly title: string | null;
  readonly due: NeedsYouDue;
};

/**
 * The Needs you cards both clients draw: who asks, the title and the deadline. Waits that expire
 * within the hour come first, soonest first; the rest keep the `needsYouItems` order.
 */
export function needsYouCards<D extends NeedsYouDecision>(
  items: ReadonlyArray<NeedsYouItem<D>>,
  nowMs: number,
): ReadonlyArray<NeedsYouCard<D>> {
  const cards = items.map((item): NeedsYouCard<D> => ({
    ...item,
    from: needsYouFrom(item.owner),
    title: item.kind === "decision" ? (item.decision.title ?? null) : null,
    due: item.kind === "decision" ? needsYouDue(item.decision.expiresAt, nowMs) : null,
  }));
  const dueAt = (card: NeedsYouCard<D>) => (card.due?.soon ? Date.parse(card.due.at) : Infinity);
  // Infinity - Infinity is NaN, which falls through to the `needsYouItems` rule.
  return cards.sort(
    (a, b) =>
      dueAt(a) - dueAt(b) ||
      compareOldestFirst(a.createdAt, b.createdAt) ||
      a.key.localeCompare(b.key),
  );
}

export interface ZoneTeam {
  readonly environmentId: string;
  readonly team: {
    readonly id: string;
    readonly memberIds: ReadonlyArray<string>;
    readonly chat?: FolderChat | null | undefined;
  };
}

export interface ZoneAssistant {
  readonly environmentId: string;
  readonly assistant: { readonly id: string };
}

/**
 * Teams zone rows: each assistant once, in the first group (team order) that lists it, and the
 * rest in the ungrouped list, keeping input order. Folders follow `folderAttention`, ties in team
 * order, and carry their `countWaits` so the indicator reads the same count.
 */
export function teamsLayout<
  A extends {
    readonly entry: ZoneAssistant;
    readonly presence: { readonly mood: AssistantMood };
    readonly activityAt: number;
  },
  T extends ZoneTeam,
>(input: {
  readonly assistants: ReadonlyArray<A>;
  readonly teams: ReadonlyArray<T>;
  /** The Needs you items. */
  readonly items: ReadonlyArray<{ readonly owner: ThreadOwner }>;
}): {
  readonly folders: ReadonlyArray<{
    readonly team: T;
    readonly members: ReadonlyArray<A>;
    readonly needsYou: number;
    readonly indicator: ZoneIndicator | null;
  }>;
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
    const needsYou = countWaits(input.items, {
      assistantKeys: new Set(
        members.map((item) => keyOf(item.entry.environmentId, item.entry.assistant.id)),
      ),
      teamKey: keyOf(team.environmentId, team.team.id),
    });
    const indicator = folderIndicator({
      needsYou,
      members: members.map(({ presence }) => ({ mood: presence.mood })),
      chat: team.team.chat ?? null,
    });
    return { team, members, needsYou, indicator };
  });
  const ungrouped = [...byKey].flatMap(([key, item]) => (claimed.has(key) ? [] : [item]));
  return {
    folders: sortByAttention(folders, ({ members, indicator }) =>
      folderAttention({ indicator, members }),
    ),
    ungrouped,
  };
}

export type ZoneIndicator =
  | { readonly kind: "needs"; readonly count: number }
  | { readonly kind: "failed" }
  | { readonly kind: "limited" }
  | { readonly kind: "paused"; readonly count: number }
  | { readonly kind: "running"; readonly count: number }
  | { readonly kind: "unread"; readonly count: number };

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

/** An assistant row's one indicator from its `assistantStatus` mood: waits on you, failed, held by a usage limit, or working. */
export function assistantIndicator(input: {
  readonly needsYou: number;
  readonly mood: AssistantMood;
}): ZoneIndicator | null {
  if (input.mood === "needs") return { kind: "needs", count: Math.max(1, input.needsYou) };
  if (input.mood === "failed") return { kind: "failed" };
  if (input.mood === "limited") return { kind: "limited" };
  if (input.mood === "working") return { kind: "running", count: 1 };
  return null;
}

type FolderChat = Pick<AssistantTeamChat, "scopes"> & {
  readonly pausedTasks: number;
  readonly failedTasks: number;
  readonly unreadCount: number;
};

/**
 * A group folder's one indicator, from the members drawn inside it and the group's own threads:
 * needs you (a counted wait, or a tab the server flags as waiting), then running N (one working
 * member makes the group working), failed, a member held by a usage limit, paused, then unread.
 */
export function folderIndicator(input: {
  /** From `countWaits` over the drawn members and the group's key. */
  readonly needsYou: number;
  readonly members: ReadonlyArray<{ readonly mood: AssistantMood }>;
  readonly chat: FolderChat | null;
}): ZoneIndicator | null {
  if (input.needsYou > 0) return { kind: "needs", count: input.needsYou };
  if (assistantGroupChatWaiting(input.chat ?? undefined)) return { kind: "needs", count: 1 };
  const running = input.members.filter((member) => member.mood === "working").length;
  if (running > 0) return { kind: "running", count: running };
  if (
    (input.chat?.failedTasks ?? 0) > 0 ||
    input.members.some((member) => member.mood === "failed")
  )
    return { kind: "failed" };
  if (input.members.some((member) => member.mood === "limited")) return { kind: "limited" };
  if ((input.chat?.pausedTasks ?? 0) > 0) return { kind: "paused", count: input.chat!.pausedTasks };
  if ((input.chat?.unreadCount ?? 0) > 0) return { kind: "unread", count: input.chat!.unreadCount };
  return null;
}

const FOLDER_DETAIL_LINES = 4;

/**
 * Where a group folder's indicator comes from, one line per tab and kind ("<kind> · <tab>[:
 * <request>]"): what needs the user, then work running, then unread. At most four, then "+N".
 * An older server sends no `waitingRequest`, so its lines name only the tab.
 */
export function folderIndicatorDetail(input: {
  readonly chat: Pick<AssistantTeamChat, "scopes" | "removedProjectIds">;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly groupProjectIds: ReadonlyArray<ProjectId>;
}): ReadonlyArray<string> {
  const scopes = input.chat.scopes ?? [];
  const tab = (projectId: ProjectId | null) =>
    projectId === null
      ? "General"
      : assistantGroupProjectLabel(
          projectId,
          input.projects,
          scopes,
          input.groupProjectIds,
          input.chat.removedProjectIds,
        );
  const lines = [
    ...scopes.flatMap((scope) => {
      if (!scope.waiting) return [];
      const request = scope.waitingRequest;
      return [
        `Needs you · ${tab(scope.projectId)}${
          request === undefined ? "" : `: ${request.title} (${assistantGroupWaitingWhy(request)})`
        }`,
      ];
    }),
    ...scopes.flatMap((scope) =>
      (scope.openTasks ?? 0) > 0 ? [`${scope.openTasks} running · ${tab(scope.projectId)}`] : [],
    ),
    ...scopes.flatMap((scope) =>
      scope.unreadCount > 0 ? [`${scope.unreadCount} unread · ${tab(scope.projectId)}`] : [],
    ),
  ];
  return lines.length <= FOLDER_DETAIL_LINES
    ? lines
    : [...lines.slice(0, FOLDER_DETAIL_LINES), `+${lines.length - FOLDER_DETAIL_LINES}`];
}

/** Where a click on a group's indicator leads: the tab and request of its first wait, if known. */
export function folderIndicatorTarget(chat: Pick<AssistantTeamChat, "scopes"> | undefined): {
  readonly tab: AssistantGroupTabKey;
  readonly requestId: string;
} | null {
  const scope = chat?.scopes?.find((entry) => entry.waiting && entry.waitingRequest !== undefined);
  return scope?.waitingRequest === undefined
    ? null
    : { tab: assistantGroupTabKey(scope.projectId), requestId: scope.waitingRequest.requestId };
}

/** The words every screen shows for an indicator; an assistant reads Working, a group N running. */
export function zoneIndicatorLabel(
  indicator: ZoneIndicator,
  subject: "assistant" | "group",
): string {
  switch (indicator.kind) {
    case "needs":
      return indicator.count === 1 ? "Needs you" : `${indicator.count} need you`;
    case "failed":
      return "Failed";
    case "limited":
      return "Usage limit";
    case "paused":
      return `${indicator.count} paused`;
    case "running":
      return subject === "assistant" ? "Working" : `${indicator.count} running`;
    case "unread":
      return `${indicator.count} unread`;
  }
}

/**
 * A group folder's place in the Teams zone, read from its own indicator so the row never sorts
 * as waiting or working while it shows something else.
 */
export function folderAttention(input: {
  readonly indicator: ZoneIndicator | null;
  readonly members: ReadonlyArray<{ readonly activityAt: number }>;
}): AttentionKey {
  const activityAt = Math.max(0, ...input.members.map((member) => member.activityAt));
  const kind = input.indicator?.kind;
  return {
    tier: kind === "needs" ? "needsYou" : kind === "running" ? "working" : "rest",
    activityAt,
  };
}

export const ENVIRONMENT_DISCONNECTED_LABEL = "This environment is disconnected";

/**
 * The one status every screen shows for an assistant (sidebar, Home, info, Work, a thread's
 * presence menu). A known-disconnected environment wins, since its cached threads are stale. Then
 * comes a wait the Needs you list holds, then a failed run, then work in its own threads or in
 * tasks it launched, then idle.
 */
export function assistantStatus(input: {
  /** `assistantPresence` of its own conversation and group threads. */
  readonly presence: AssistantPresence;
  /** `countWaits` for this assistant alone. */
  readonly needsYou: number;
  /** Its live launched tasks and delegated children. */
  readonly sites: ReadonlyArray<Pick<AssistantWorkSite, "face">>;
  /** False when its environment is known to be unreachable; null while that is unknown. */
  readonly reachable: boolean | null;
}): AssistantPresence {
  const { presence } = input;
  const still = { since: null, reading: false } as const;
  if (input.reachable === false) {
    return { mood: "idle", detail: ENVIRONMENT_DISCONNECTED_LABEL, ...still, queued: 0 };
  }
  if (input.needsYou > 0) {
    return presence.mood === "needs"
      ? presence
      : { ...presence, mood: "needs", detail: "Needs you", ...still };
  }
  if (presence.mood === "failed" || presence.mood === "working") return presence;
  // A request nobody lists (T3 answers it itself) and a live task are both work in progress.
  if (presence.mood === "needs" || input.sites.length > 0) {
    return { ...presence, mood: "working", detail: "Working", ...still };
  }
  return presence;
}

/**
 * Every assistant's `assistantStatus` at once, from the shared state both clients hold: `items` is
 * the Needs you list, `read` adjusts a presence in hand, `of` reads an assistant from the shells.
 */
export function assistantStatusOf<
  S extends ZoneShell & Parameters<typeof assistantPresenceOf>[2][number],
  D extends NeedsYouDecision,
>(input: {
  readonly shells: ReadonlyArray<S>;
  readonly decisions: ReadonlyArray<{ readonly environmentId: string; readonly decision: D }>;
  readonly ownerOf: (shell: Pick<S, "environmentId" | "id">) => ThreadOwner;
  readonly sites: ReadonlyArray<AssistantWorkSite>;
  readonly reachable: (environmentId: string) => boolean | null;
}) {
  const { shells, sites } = input;
  const items = needsYouItems({ shells, decisions: input.decisions, ownerOf: input.ownerOf });
  const read = (environmentId: string, assistantId: string, presence: AssistantPresence) =>
    assistantStatus({
      presence,
      needsYou: countWaits(items, { assistantKeys: new Set([keyOf(environmentId, assistantId)]) }),
      sites: sites.filter(
        (site) => site.environmentId === environmentId && site.assistantId === assistantId,
      ),
      reachable: input.reachable(environmentId),
    });
  const of = (
    environmentId: string,
    assistant: { readonly id: string; readonly threadId: string | null } | null,
    /** The platform's `useUsageLimitLabel`, so a limit says until when. */
    limitLabel?: (resetAt: string | null | undefined) => string | null,
  ) =>
    assistant === null
      ? assistantPresence(null)
      : read(
          environmentId,
          assistant.id,
          assistantPresenceOf(assistant, environmentId, shells, limitLabel),
        );
  return { items, read, of };
}
