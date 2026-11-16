import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  foldSearchQuery,
  PALETTE_SECONDARY_LIMIT,
  PALETTE_THREAD_LIMIT,
  rankSearchGroups,
  scoreSearchTerms,
  scoreThreadSearch,
  type SearchMatchHint,
  type SearchRange,
  type SearchTermsMatch,
  type ThreadSearchSubject,
} from "@t3tools/shared/paletteSearch";

import { RESOURCE_MANAGER_LABELS } from "../resources/resourceManagerCopy";
import type { SettingsPageTarget } from "../settings/components/settings-page-targets";
import { SETTINGS_PAGE_LABELS } from "../settings/settings-search";
import { USAGE_PAGE_LABELS } from "../usage/usageCopy";
import { parseActiveGroupChatPath, parseActiveThreadPath } from "./hardwareKeyboardCommands";

export interface CommandPaletteItem {
  readonly key: string;
  readonly kind: "action" | "project" | "thread";
  readonly project?: EnvironmentProject;
  readonly title: string;
  readonly detail?: string;
  readonly searchTerms: ReadonlyArray<string>;
  /** Thread rows rank by match quality and use instead of by `searchTerms`. */
  readonly threadSearch?: ThreadSearchSubject;
  /** Listed last in its group, as the thread already open. */
  readonly secondary?: boolean;
  readonly run: () => void;
}

const PAGE_TERMS: Partial<Record<SettingsPageTarget, readonly string[]>> = {
  ...SETTINGS_PAGE_LABELS,
  SettingsResourceManager: RESOURCE_MANAGER_LABELS,
  SettingsUsage: USAGE_PAGE_LABELS,
};

/**
 * An action that opens a Settings page, found by the text that page draws, as Settings search finds
 * it. `liveLabels` adds text the page draws from live state.
 */
export function settingsPageItem(
  key: string,
  title: string,
  target: SettingsPageTarget,
  open: (target: SettingsPageTarget) => void,
  liveLabels: readonly string[] = [],
): CommandPaletteItem {
  return {
    key,
    kind: "action",
    title,
    searchTerms: [...(PAGE_TERMS[target] ?? []), ...liveLabels],
    run: () => open(target),
  };
}

/** The reverse-able pause for assistant notifications; absent when no server runs assistants. */
export function autonomyPauseItems(
  pause: { readonly enabled: boolean; readonly toggle: () => unknown } | null,
): CommandPaletteItem[] {
  return pause === null
    ? []
    : [
        {
          key: "toggle-assistant-notifications",
          kind: "action",
          title: pause.enabled
            ? "Pause assistant notifications"
            : "Turn on assistant notifications",
          searchTerms: [
            "assistant",
            "notifications",
            "autonomy",
            "pause",
            "resume",
            "mute",
            "wake",
          ],
          run: () => void pause.toggle(),
        },
      ];
}

/** "Assistant info" on an assistant's chat, "Group info" on a group chat; nothing elsewhere. */
export function assistantInfoItems<
  A extends {
    readonly environmentId: string;
    readonly assistant: { readonly name: string; readonly threadId: string | null };
  },
  T extends {
    readonly environmentId: string;
    readonly team: { readonly id: string; readonly name: string };
  },
>(input: {
  readonly pathname: string;
  readonly assistants: ReadonlyArray<A>;
  readonly teams: ReadonlyArray<T>;
  readonly openAssistant: (entry: A) => void;
  readonly openGroup: (entry: T) => void;
}): CommandPaletteItem[] {
  const thread = parseActiveThreadPath(input.pathname);
  const assistant =
    thread === null
      ? undefined
      : input.assistants.find(
          (entry) =>
            entry.environmentId === thread.environmentId &&
            entry.assistant.threadId === thread.threadId,
        );
  const group = parseActiveGroupChatPath(input.pathname);
  const team =
    group === null
      ? undefined
      : input.teams.find(
          (entry) => entry.environmentId === group.environmentId && entry.team.id === group.teamId,
        );
  return [
    ...(assistant
      ? [
          {
            key: "assistantInfo",
            kind: "action" as const,
            title: "Assistant info",
            searchTerms: ["assistant", "info", "projects", "access", assistant.assistant.name],
            run: () => input.openAssistant(assistant),
          },
        ]
      : []),
    ...(team
      ? [
          {
            key: "groupInfo",
            kind: "action" as const,
            title: "Group info",
            searchTerms: ["group", "info", "members", "team", team.team.name],
            run: () => input.openGroup(team),
          },
        ]
      : []),
  ];
}

export interface CommandPaletteResult extends CommandPaletteItem {
  /** Listed because its messages match; the row shows the message snippet. */
  readonly fromMessages?: boolean;
  /** Title ranges the query matched, for highlighting. */
  readonly titleRanges?: ReadonlyArray<SearchRange>;
  /** Shown in place of the detail when the match is not in the title. */
  readonly matchHint?: SearchMatchHint;
}

/**
 * Ranks like the web palette: actions, projects, and threads order by their
 * best match, threads by match quality and use. Threads whose messages match
 * come last, in `messageMatchKeys` order, so late server results never move
 * the rows above them.
 */
export function filterCommandPaletteItems(
  items: ReadonlyArray<CommandPaletteItem>,
  query: string,
  messageMatchKeys: ReadonlyArray<string>,
  now = Date.now(),
): CommandPaletteResult[] {
  const actionsOnly = query.startsWith(">");
  const normalizedQuery = foldSearchQuery(actionsOnly ? query.slice(1) : query);
  const candidates = actionsOnly ? items.filter((item) => item.kind === "action") : items;
  if (!normalizedQuery) return candidates.filter((item) => item.kind !== "project");

  // On equal match classes, groups keep this order, as on web.
  const kinds = ["action", "thread", "project"] as const;
  const groups = rankSearchGroups(
    kinds.map((kind) => ({ group: kind, items: candidates.filter((item) => item.kind === kind) })),
    (
      item,
      options,
    ): (SearchTermsMatch & { explain?: () => SearchMatchHint | undefined }) | null => {
      const match = item.threadSearch
        ? scoreThreadSearch(normalizedQuery, item.threadSearch, now, options)
        : scoreSearchTerms(normalizedQuery, [item.title, ...item.searchTerms], options);
      // The open thread, listed last, does not decide where its group sits.
      return match && item.secondary ? { ...match, groupQuality: 0 } : match;
    },
  );
  const threadsMatch = groups.some(({ group }) => group === "thread");
  const ranked = groups.flatMap(({ group, ranked: entries }) =>
    [...entries]
      // Stable, so rank order holds otherwise.
      .sort(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false),
      )
      .slice(
        0,
        group === "thread"
          ? PALETTE_THREAD_LIMIT
          : threadsMatch && !actionsOnly
            ? PALETTE_SECONDARY_LIMIT
            : entries.length,
      )
      .map(({ item, match }): CommandPaletteResult => {
        // Built only for the rows shown.
        const matchHint = match.explain?.();
        return { ...item, titleRanges: match.ranges, ...(matchHint ? { matchHint } : {}) };
      }),
  );
  if (actionsOnly) return ranked;

  const listed = new Set(ranked.map((item) => item.key));
  const threadByKey = new Map(
    items.filter((item) => item.kind === "thread").map((item) => [item.key, item]),
  );
  // `messageMatchKeys` arrive cut to what the palette shows; see `nextShownOrder`.
  const fromMessages = messageMatchKeys.flatMap((key) => {
    const item = threadByKey.get(key);
    return item && !listed.has(key) ? [{ ...item, fromMessages: true }] : [];
  });
  return [...ranked, ...fromMessages];
}

export function nextPaletteIndex(index: number, direction: -1 | 1, count: number) {
  return count === 0 ? 0 : (index + direction + count) % count;
}
