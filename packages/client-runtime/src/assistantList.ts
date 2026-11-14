import {
  assistantGroupThreadsOf,
  assistantPresence,
  type AssistantPresence,
} from "./assistantRobot.ts";

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
): Array<RankedAssistant<E>> {
  const byThread = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  return entries
    .map((entry) => {
      const { assistant, environmentId } = entry;
      const own =
        assistant.threadId === null
          ? null
          : (byThread.get(`${environmentId}:${assistant.threadId}`) ?? null);
      const presence = assistantPresence(
        own,
        assistantGroupThreadsOf(shells, environmentId, assistant.id),
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

/** The one muted status a list row shows: null when idle, so the row has no second line. */
export function assistantMetaLabel(presence: AssistantPresence): string | null {
  switch (presence.mood) {
    case "needs":
      return "Needs you";
    case "working":
      return presence.detail.startsWith("Working in ") ? presence.detail : "Working";
    case "limited":
    case "failed":
      return presence.detail;
    case "idle":
      return null;
  }
}
