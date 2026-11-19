import { useAtomValue } from "@effect/atom-react";
import { rankAssistants } from "@t3tools/client-runtime/assistantList";
import { environmentReachable } from "@t3tools/client-runtime/connection";
import {
  assistantStatusOf,
  teamsLayout,
  threadOwnerResolver,
  type ZoneIndicator,
} from "@t3tools/client-runtime/sidebarZones";
import { workingItems, workingRows } from "@t3tools/client-runtime/workingConsumers";
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
  const working = workingItems({ shells, ownerOf, teams: activeTeams });
  return { shells, active, activeTeams, ownerOf, working, ...status };
}

/**
 * Assistants, group members and subagents working now, with who and on which machine, for the
 * sidebar's Working zone and Activity's Working section.
 */
export function useWorkingRows() {
  return toWorkingRows(
    useAssistantStatus(),
    useAtomValue(environmentPresentations.presentationsAtom),
  );
}

function toWorkingRows(
  status: ReturnType<typeof useAssistantStatus>,
  presentations: ReadonlyMap<
    EnvironmentId,
    { readonly entry: { readonly target: { readonly label: string } } }
  >,
) {
  const { shells, active, activeTeams, working } = status;
  if (working.length === 0) return [];
  const byKey = <T>(entries: ReadonlyArray<T>, key: (entry: T) => string) =>
    new Map(entries.map((entry) => [key(entry), entry] as const));
  const assistants = byKey(active, (entry) => `${entry.environmentId}:${entry.assistant.id}`);
  const teams = byKey(activeTeams, (entry) => `${entry.environmentId}:${entry.team.id}`);
  const threads = byKey(shells, (shell) => `${shell.environmentId}:${shell.id}`);
  return workingRows(working, {
    // Work routed to a linked machine names an assistant that lives on another environment.
    assistant: (environmentId, id) =>
      (
        assistants.get(`${environmentId}:${id}`) ??
        active.find((entry) => entry.assistant.id === id)
      )?.assistant.name,
    group: (environmentId, id) =>
      (teams.get(`${environmentId}:${id}`) ?? activeTeams.find((entry) => entry.team.id === id))
        ?.team.name,
    thread: (environmentId, id) => threads.get(`${environmentId}:${id}`)?.title,
    environment: (environmentId) =>
      presentations.get(environmentId as EnvironmentId)?.entry.target.label,
  });
}

/**
 * The sidebar's three zones derived once from app state: what waits on the user, who owns each
 * thread, and the Teams layout with its indicators. Every zone and count reads this one result.
 */
export function useSidebarZones() {
  const status = useAssistantStatus();
  const working = toWorkingRows(status, useAtomValue(environmentPresentations.presentationsAtom));
  const { shells, active, activeTeams, ownerOf, items, read, indicator: indicatorOf } = status;
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
    working,
    ownerOf,
    layout,
    indicators: { assistant: assistantIndicators, folder: folderIndicators },
  };
}

export type SidebarZones = ReturnType<typeof useSidebarZones>;
