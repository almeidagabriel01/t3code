import {
  assistantSectionThreadKeys,
  type AssistantTaskRow,
  type AssistantTaskSections,
} from "@t3tools/client-runtime/assistantTasks";
import { visibleAssistants } from "@t3tools/client-runtime/assistantList";
import type { AssistantMood } from "@t3tools/client-runtime/assistantRobot";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ZoneIndicator } from "@t3tools/client-runtime/sidebarZones";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import {
  type AssistantEntry,
  type AssistantTeamEntry,
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
} from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { resolveSubagentDisplay } from "../sidebar/sidebarDisplay.logic";
import type { SidebarZones } from "../sidebar/useSidebarZones";
import { assistantFoldKey, assistantShelfOpen, assistantTaskSectionsOf } from "./AssistantTaskRows";

/** What one assistant's sidebar row draws under it. */
export interface AssistantSidebarItem {
  readonly sections: AssistantTaskSections<EnvironmentThreadShell>;
  readonly expanded: boolean;
  /** Live delegated children of its chat and group threads, pinned ones first. */
  readonly subagents: ReadonlyArray<EnvironmentThreadShell>;
}

/** One row of the Teams zone, in drawn order. */
export type TeamsRow =
  | {
      readonly kind: "folder";
      /** The `sidebarAssistantsExpandedGroups` key. */
      readonly key: string;
      readonly team: AssistantTeamEntry;
      readonly members: ReadonlyArray<AssistantEntry>;
      readonly expanded: boolean;
      readonly indicator: ZoneIndicator | null;
    }
  | {
      readonly kind: "assistant";
      /** `env:assistantId`. */
      readonly key: string;
      readonly entry: AssistantEntry;
      readonly nested: boolean;
      readonly mood: AssistantMood;
      readonly indicator: ZoneIndicator | null;
      readonly item: AssistantSidebarItem;
    }
  | {
      readonly kind: "more";
      readonly key: "more";
      readonly showAll: boolean;
      readonly total: number;
    };

const NO_SUBAGENTS: ReadonlyArray<EnvironmentThreadShell> = [];

const sameRows = (
  a: ReadonlyArray<AssistantTaskRow<EnvironmentThreadShell>>,
  b: ReadonlyArray<AssistantTaskRow<EnvironmentThreadShell>>,
) =>
  a.length === b.length &&
  a.every((row, index) => {
    const other = b[index]!;
    return row.task === other.task && row.shell === other.shell && row.state === other.state;
  });

/** Rebuilt on every derivation; rows compare it by content, so an unchanged one draws nothing. */
export const sameItem = (a: AssistantSidebarItem, b: AssistantSidebarItem) =>
  a.expanded === b.expanded &&
  a.subagents.length === b.subagents.length &&
  a.subagents.every((thread, index) => thread === b.subagents[index]) &&
  sameRows(a.sections.pinned, b.sections.pinned) &&
  sameRows(a.sections.open, b.sections.open) &&
  sameRows(a.sections.snoozed, b.sections.snoozed) &&
  sameRows(a.sections.settled, b.sections.settled);

/**
 * The Teams zone in drawn order: ungrouped assistants, then each group's folder and, when open,
 * its members. Render and ⌘1–9 read this one list, so the hints number the rows on screen.
 */
export function useAssistantSidebarModel(zones: SidebarZones) {
  const enabled = useClientSettings((settings) => settings.sidebarShowAssistantsSection);
  const collapsed = useClientSettings((settings) => settings.sidebarAssistantsCollapsed);
  const expandedGroups = useClientSettings((settings) => settings.sidebarAssistantsExpandedGroups);
  const showAll = useClientSettings((settings) => settings.sidebarAssistantsShowAll);
  const showSubagents = useClientSettings((settings) => settings.sidebarShowSubagents);
  const subagentMode = useClientSettings((settings) => settings.sidebarAgentActivityDisplayMode);
  const threadOrder = useClientSettings((settings) => settings.sidebarThreadOrder);
  const folds = useUiStateStore((state) => state.projectExpandedById);
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const openDecisionKeys = useOpenDecisionThreadKeys();
  const nowMs = useNowMinuteMs();
  const shells = useQuietThreadShells();
  const work = useAssistantLiveWork();
  const tasksByAssistant = useAssistantTasksByAssistant();

  const { layout, indicators } = zones;
  const shellByKey = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  const itemOf = (entry: AssistantEntry): AssistantSidebarItem => {
    const key = `${entry.environmentId}:${entry.assistant.id}`;
    // A task's own thread is drawn as its task row, never again as a subagent.
    const live = (work.subagents.get(key) ?? NO_SUBAGENTS).filter(
      (thread) => !work.taskThreadKeys.has(`${thread.environmentId}:${thread.id}`),
    );
    const pinned = live.filter((thread) => thread.pinnedAt != null);
    return {
      sections: assistantTaskSectionsOf({
        tasks: tasksByAssistant.get(key) ?? [],
        shellOf: (threadId) => shellByKey.get(`${entry.environmentId}:${threadId}`),
        threadOrder,
        attention: { lastVisitedAtByKey, openDecisionKeys },
        nowMs,
      }),
      expanded: resolveProjectExpanded(folds, [assistantFoldKey(entry)]),
      subagents:
        pinned.length === 0
          ? live
          : [
              ...sortPinnedThreadsByOrderKey(pinned),
              ...live.filter((thread) => thread.pinnedAt == null),
            ],
    };
  };
  const assistantRow = (
    { entry, presence }: (typeof layout.ungrouped)[number],
    nested: boolean,
  ): TeamsRow => {
    const key = `${entry.environmentId}:${entry.assistant.id}`;
    return {
      kind: "assistant",
      key,
      entry,
      nested,
      mood: presence.mood,
      indicator: indicators.assistant.get(key) ?? null,
      item: itemOf(entry),
    };
  };

  const ungrouped = visibleAssistants(layout.ungrouped, showAll);
  const rows: TeamsRow[] =
    !enabled || collapsed
      ? []
      : [
          ...ungrouped.shown.map((ranked) => assistantRow(ranked, false)),
          ...(ungrouped.hidden > 0 || showAll
            ? [
                {
                  kind: "more",
                  key: "more",
                  showAll,
                  total: layout.ungrouped.length,
                } satisfies TeamsRow,
              ]
            : []),
          ...layout.folders.flatMap(({ team, members }): TeamsRow[] => {
            const key = `group:${team.environmentId}:${team.team.id}`;
            const expanded = members.length > 0 && expandedGroups.includes(key);
            return [
              {
                kind: "folder",
                key,
                team,
                members: members.map((ranked) => ranked.entry),
                expanded,
                indicator: indicators.folder.get(`${team.environmentId}:${team.team.id}`) ?? null,
              },
              ...(expanded ? members.map((ranked) => assistantRow(ranked, true)) : []),
            ];
          }),
        ];

  const threadKeys = assistantSectionThreadKeys(
    rows.flatMap((row) => {
      if (row.kind !== "assistant") return [];
      const { entry, item } = row;
      const foldKey = assistantFoldKey(entry);
      // Rows a summary line folds away stay unnumbered, as the summary starts closed.
      const subagentRows =
        resolveSubagentDisplay({
          count: item.subagents.length,
          show: showSubagents,
          mode: subagentMode,
          expanded: false,
        }) === "rows";
      return [
        {
          chatKey:
            entry.assistant.threadId === null
              ? null
              : scopedThreadKey(scopeThreadRef(entry.environmentId, entry.assistant.threadId)),
          folded: !item.expanded,
          sections: item.sections,
          snoozedOpen: assistantShelfOpen(folds, foldKey, "snoozed"),
          settledOpen: assistantShelfOpen(folds, foldKey, "settled"),
          subagentKeys: subagentRows
            ? item.subagents.map((thread) => `${thread.environmentId}:${thread.id}`)
            : [],
        },
      ];
    }),
  );
  return {
    enabled,
    collapsed,
    expandedGroups,
    /** Active assistants, for the collapsed header's count. */
    count: layout.ungrouped.length + layout.folders.reduce((sum, f) => sum + f.members.length, 0),
    empty: layout.ungrouped.length === 0 && layout.folders.length === 0,
    rows,
    threadKeys,
  };
}

export type AssistantSidebarModel = ReturnType<typeof useAssistantSidebarModel>;
