import {
  assistantSectionThreadKeys,
  type AssistantTaskSections,
} from "@t3tools/client-runtime/assistantTasks";
import { rankAssistants, visibleAssistants } from "@t3tools/client-runtime/assistantList";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import {
  type AssistantEntry,
  useAssistantEntries,
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
} from "../../state/assistants";
import { useOpenDecisionThreadKeys } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { resolveSubagentDisplay } from "../sidebar/sidebarDisplay.logic";
import { assistantFoldKey, assistantShelfOpen, assistantTaskSectionsOf } from "./AssistantTaskRows";

/** What one assistant's sidebar row draws under it. */
export interface AssistantSidebarItem {
  readonly sections: AssistantTaskSections<EnvironmentThreadShell>;
  readonly expanded: boolean;
  /** Live delegated children of its chat and group threads, pinned ones first. */
  readonly subagents: ReadonlyArray<EnvironmentThreadShell>;
}

const NO_SUBAGENTS: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * The assistants section, derived once for the sidebar: what it lists and the thread keys it shows
 * in render order, so ⌘1–9 numbers the rows the section draws.
 */
export function useAssistantSidebarModel() {
  const { active, activeTeams: teams } = useAssistantEntries();
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

  const ranked = rankAssistants(active, shells);
  const { shown, hidden } = visibleAssistants(ranked, showAll);
  const shellByKey = new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell]));
  const items = new Map<string, AssistantSidebarItem>();
  for (const { entry } of ranked) {
    const key = `${entry.environmentId}:${entry.assistant.id}`;
    const live = work.subagents.get(key) ?? NO_SUBAGENTS;
    const pinned = live.filter((thread) => thread.pinnedAt != null);
    items.set(key, {
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
    });
  }

  // Render order: expanded groups' members, then the flat list. The collapsed strip has no hints.
  const rankedByKey = new Map(
    ranked.map((item) => [`${item.entry.environmentId}:${item.entry.assistant.id}`, item.entry]),
  );
  const rendered: AssistantEntry[] =
    !enabled || collapsed
      ? []
      : [
          ...teams.flatMap((team) =>
            expandedGroups.includes(`group:${team.environmentId}:${team.team.id}`)
              ? team.team.memberIds.flatMap((id) => {
                  const entry = rankedByKey.get(`${team.environmentId}:${id}`);
                  return entry === undefined ? [] : [entry];
                })
              : [],
          ),
          ...shown.map((item) => item.entry),
        ];
  const threadKeys = assistantSectionThreadKeys(
    rendered.map((entry) => {
      const item = items.get(`${entry.environmentId}:${entry.assistant.id}`)!;
      const foldKey = assistantFoldKey(entry);
      // Rows a summary line folds away stay unnumbered, as the summary starts closed.
      const subagentRows =
        resolveSubagentDisplay({
          count: item.subagents.length,
          show: showSubagents,
          mode: subagentMode,
          expanded: false,
        }) === "rows";
      return {
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
      };
    }),
  );
  return {
    enabled,
    collapsed,
    showAll,
    expandedGroups,
    active,
    teams,
    ranked,
    shown,
    hidden,
    items,
    threadKeys,
  };
}

export type AssistantSidebarModel = ReturnType<typeof useAssistantSidebarModel>;
