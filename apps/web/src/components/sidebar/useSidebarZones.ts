import { useAtomValue } from "@effect/atom-react";
import { rankAssistants } from "@t3tools/client-runtime/assistantList";
import { environmentReachable } from "@t3tools/client-runtime/connection";
import {
  assistantStatusOf,
  teamsLayout,
  threadOwnerResolver,
  type ZoneIndicator,
} from "@t3tools/client-runtime/sidebarZones";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  useAssistantEntries,
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
} from "../../state/assistants";
import { useDecisionEntries } from "../../state/decisions";
import { useQuietThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";

/**
 * What waits on the user, who owns each thread, and every assistant's one status
 * (`assistantStatus`), read alike by the sidebar, the presence popover, info and Work. `of` takes
 * an assistant; `read` adjusts a presence in hand.
 */
export function useAssistantStatus() {
  const shells = useQuietThreadShells();
  const { active, activeTeams } = useAssistantEntries();
  const tasksByAssistant = useAssistantTasksByAssistant();
  const decisions = useDecisionEntries().open;
  const { sites } = useAssistantLiveWork();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);

  const taskAssistantByThreadKey = new Map<string, string>();
  for (const [assistantKey, tasks] of tasksByAssistant) {
    const environmentId = assistantKey.slice(0, assistantKey.indexOf(":"));
    for (const task of tasks) {
      taskAssistantByThreadKey.set(`${environmentId}:${task.threadId}`, assistantKey);
    }
  }
  const teamKeyByThreadKey = new Map<string, string>();
  for (const { environmentId, team } of activeTeams) {
    for (const threadId of team.chat?.threadIds ?? []) {
      teamKeyByThreadKey.set(`${environmentId}:${threadId}`, `${environmentId}:${team.id}`);
    }
  }
  const ownerOf = threadOwnerResolver({
    shells,
    taskAssistantByThreadKey,
    teamKeyByThreadKey,
    activeAssistantKeys: new Set(
      active.map((entry) => `${entry.environmentId}:${entry.assistant.id}`),
    ),
  });
  const status = assistantStatusOf({
    shells,
    decisions,
    ownerOf,
    sites,
    reachable: (environmentId) =>
      environmentReachable(presentations.get(environmentId as EnvironmentId)?.connection),
    teams: activeTeams,
  });
  return { shells, active, activeTeams, ownerOf, ...status };
}

/**
 * The sidebar's three zones derived once from app state: what waits on the user, who owns each
 * thread, and the Teams layout with its indicators. Every zone and count reads this one result.
 */
export function useSidebarZones() {
  const {
    shells,
    active,
    activeTeams,
    ownerOf,
    items,
    read,
    indicator: indicatorOf,
  } = useAssistantStatus();
  const ranked = rankAssistants(active, shells, (entry, presence) =>
    read(entry.environmentId, entry.assistant.id, presence),
  );
  const layout = teamsLayout({ assistants: ranked, teams: activeTeams, items });
  const assistantIndicators = new Map<string, ZoneIndicator | null>();
  for (const { entry, presence } of ranked) {
    const key = `${entry.environmentId}:${entry.assistant.id}`;
    assistantIndicators.set(key, indicatorOf(entry.environmentId, entry.assistant.id, presence));
  }
  const folderIndicators = new Map(
    layout.folders.map(
      ({ team, indicator }) => [`${team.environmentId}:${team.team.id}`, indicator] as const,
    ),
  );
  return {
    items,
    ownerOf,
    layout,
    indicators: { assistant: assistantIndicators, folder: folderIndicators },
  };
}

export type SidebarZones = ReturnType<typeof useSidebarZones>;
