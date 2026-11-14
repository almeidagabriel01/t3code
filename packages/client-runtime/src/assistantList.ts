import {
  assistantGroupThreadsOf,
  assistantPresence,
  type AssistantPresence,
} from "./assistantRobot.ts";
import { resolveSidebarThreadStatus } from "./state/threadAttention.ts";

type RankShell = NonNullable<Parameters<typeof assistantPresence>[0]> & {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
};

export interface RankableAssistant {
  readonly environmentId: string;
  readonly assistant: {
    readonly id: string;
    readonly name: string;
    readonly threadId: string | null;
  };
}

export interface RankedAssistant<E extends RankableAssistant> {
  readonly entry: E;
  readonly presence: AssistantPresence;
  /** Epoch ms of the assistant thread's last update; 0 when it has no thread. */
  readonly activityAt: number;
}

/** Others shown beside the active ones before "Show all". */
const RECENT_ASSISTANT_LIMIT = 5;

const rankOf = (mood: AssistantPresence["mood"]) =>
  mood === "needs" ? 0 : mood === "working" ? 1 : 2;

/** Needs you first, then working, then the rest by latest activity, falling back to name. */
export function rankAssistants<E extends RankableAssistant>(
  entries: ReadonlyArray<E>,
  shells: ReadonlyArray<RankShell>,
  /** The shared `assistantStatus` reading; the bare presence when omitted. */
  statusOf: (entry: E, presence: AssistantPresence) => AssistantPresence = (_entry, presence) =>
    presence,
): Array<RankedAssistant<E>> {
  const byThread = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  return entries
    .map((entry) => {
      const { assistant, environmentId } = entry;
      const own =
        assistant.threadId === null
          ? null
          : (byThread.get(`${environmentId}:${assistant.threadId}`) ?? null);
      const presence = statusOf(
        entry,
        assistantPresence(own, assistantGroupThreadsOf(shells, environmentId, assistant.id)),
      );
      const parsed = own === null ? Number.NaN : Date.parse(own.updatedAt);
      return { entry, presence, activityAt: Number.isNaN(parsed) ? 0 : parsed };
    })
    .sort(
      (a, b) =>
        rankOf(a.presence.mood) - rankOf(b.presence.mood) ||
        b.activityAt - a.activityAt ||
        a.entry.assistant.name.localeCompare(b.entry.assistant.name),
    );
}

/** Every active assistant plus the most recent others; `hidden` counts what "Show all" reveals. */
export function visibleAssistants<R extends { readonly presence: { readonly mood: string } }>(
  ranked: ReadonlyArray<R>,
  showAll: boolean,
): { readonly shown: ReadonlyArray<R>; readonly hidden: number } {
  const active = ranked.filter(
    ({ presence }) => presence.mood === "needs" || presence.mood === "working",
  );
  const shown = showAll ? ranked : ranked.slice(0, active.length + RECENT_ASSISTANT_LIMIT);
  return { shown, hidden: ranked.length - shown.length };
}

/** The preference key that remembers one group open in an assistant list. */
export const assistantGroupFoldKey = (environmentId: string, teamId: string) =>
  `group:${environmentId}:${teamId}`;

/** Opens a closed fold or closes an open one, keeping the other keys as they were. */
export const toggleFoldKey = (keys: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
  keys.includes(key) ? keys.filter((candidate) => candidate !== key) : [...keys, key];

export interface FoldableTeam {
  readonly environmentId: string;
  readonly team: { readonly id: string; readonly memberIds: ReadonlyArray<string> };
}

export interface AssistantGroupFold<T, R> {
  readonly team: T;
  /** In rank order, so whoever needs the user or works is on top. */
  readonly members: ReadonlyArray<R>;
}

/**
 * Splits ranked assistants for a list: an assistant in no group stands alone, and each group holds
 * its members, so one in several groups is listed under each and never on its own.
 */
export function assistantGroupFolds<
  R extends { readonly entry: RankableAssistant },
  T extends FoldableTeam,
>(
  ranked: ReadonlyArray<R>,
  teams: ReadonlyArray<T>,
): { readonly loose: ReadonlyArray<R>; readonly groups: ReadonlyArray<AssistantGroupFold<T, R>> } {
  const grouped = new Set<string>();
  const groups = teams.map((team) => {
    const memberIds = new Set(team.team.memberIds);
    const members = ranked.filter(
      ({ entry }) =>
        entry.environmentId === team.environmentId && memberIds.has(entry.assistant.id),
    );
    for (const { entry } of members) grouped.add(`${entry.environmentId}:${entry.assistant.id}`);
    return { team, members };
  });
  const loose = ranked.filter(
    ({ entry }) => !grouped.has(`${entry.environmentId}:${entry.assistant.id}`),
  );
  return { loose, groups };
}

/**
 * What an assistant or a group shows in the threads' own words, most urgent first: waiting on the
 * user, then failed, then working, then finished work the user has not seen.
 */
export const ASSISTANT_ATTENTION_ORDER = [
  "approval",
  "input",
  "request",
  "decision",
  "paused",
  "limited",
  "failed",
  "working",
  "done",
] as const;
export type AssistantAttention = (typeof ASSISTANT_ATTENTION_ORDER)[number];

type AttentionThread = Parameters<typeof resolveSidebarThreadStatus>[0] & {
  readonly environmentId: string;
  readonly id: string;
};

const THREAD_ATTENTION: Partial<
  Record<ReturnType<typeof resolveSidebarThreadStatus>, AssistantAttention>
> = {
  approval: "approval",
  input: "input",
  request: "request",
  limited: "limited",
  failed: "failed",
  working: "working",
};

/**
 * The most urgent state across an assistant's or a group's threads and tasks. A thread with an open
 * decision says "decision" unless it already asks for approval or input, as a thread row does.
 */
export function assistantAttention<T extends AttentionThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly hasOpenDecision: (thread: T) => boolean;
  /** Group tasks stopped for a reason the user did not choose, waiting on them. */
  readonly pausedTasks?: number | undefined;
  readonly failedTasks?: number | undefined;
  /** A task is queued or running even when no thread runs yet. */
  readonly working?: boolean | undefined;
  /** Finished work the user has not seen yet. */
  readonly unseenDone?: boolean | undefined;
}): AssistantAttention | null {
  const found = new Set<AssistantAttention>();
  for (const thread of input.threads) {
    const status = THREAD_ATTENTION[resolveSidebarThreadStatus(thread)];
    const decision = input.hasOpenDecision(thread);
    if (decision && status !== "approval" && status !== "input") found.add("decision");
    else if (status !== undefined) found.add(status);
  }
  if ((input.pausedTasks ?? 0) > 0) found.add("paused");
  if ((input.failedTasks ?? 0) > 0) found.add("failed");
  if (input.working === true) found.add("working");
  if (input.unseenDone === true) found.add("done");
  return ASSISTANT_ATTENTION_ORDER.find((state) => found.has(state)) ?? null;
}

/**
 * A group's status: its members' own conversations, every member's thread for this group, and its
 * tasks. "Done" is the group chat's unread news, so the group's own read marker clears it.
 */
export function assistantGroupAttention<T extends AttentionThread>(input: {
  readonly shells: ReadonlyArray<T>;
  readonly hasOpenDecision: (thread: T) => boolean;
  readonly environmentId: string;
  readonly memberThreadIds: ReadonlyArray<string | null>;
  readonly chat:
    | {
        readonly threadIds: ReadonlyArray<string>;
        readonly pausedTasks: number;
        readonly failedTasks: number;
        readonly working: boolean;
        readonly unreadCount: number;
      }
    | null
    | undefined;
}): AssistantAttention | null {
  const ids = new Set([...input.memberThreadIds, ...(input.chat?.threadIds ?? [])]);
  return assistantAttention({
    threads: input.shells.filter(
      (shell) => shell.environmentId === input.environmentId && ids.has(shell.id),
    ),
    hasOpenDecision: input.hasOpenDecision,
    pausedTasks: input.chat?.pausedTasks,
    failedTasks: input.chat?.failedTasks,
    working: input.chat?.working,
    unseenDone: (input.chat?.unreadCount ?? 0) > 0,
  });
}
