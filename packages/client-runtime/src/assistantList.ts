import {
  assistantGroupThreadsOf,
  assistantPresence,
  type AssistantPresence,
} from "./assistantRobot.ts";
import { attentionTierOfMood, sortByAttention } from "./attentionOrder.ts";

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

/** In `sortByAttention` order, falling back to name. */
export function rankAssistants<E extends RankableAssistant>(
  entries: ReadonlyArray<E>,
  shells: ReadonlyArray<RankShell>,
  /** The shared `assistantStatus` reading, so rows sort by the status their labels show. */
  statusOf: (entry: E, presence: AssistantPresence) => AssistantPresence,
): Array<RankedAssistant<E>> {
  const byThread = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  const ranked = entries.map((entry) => {
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
  });
  return sortByAttention(
    ranked,
    ({ presence, activityAt }) => ({ tier: attentionTierOfMood(presence.mood), activityAt }),
    (a, b) => a.entry.assistant.name.localeCompare(b.entry.assistant.name),
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
