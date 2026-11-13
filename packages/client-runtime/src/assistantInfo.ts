import type { Assistant, AssistantTeam } from "@t3tools/contracts";

import { listedProjects, type SectionAssistant } from "./assistantSections.ts";

export interface AssistantInfoProject {
  readonly projectId: string;
  readonly name: string;
  readonly workingNow: boolean;
}

/**
 * The Projects section: "All projects" for scope `all`, plus the projects it works in now;
 * otherwise its listed projects, each marked when it works there now.
 */
export function assistantInfoProjects(
  assistant: SectionAssistant["assistant"],
  workingNow: ReadonlyArray<{ readonly projectId: string }>,
  nameOf: (projectId: string) => string,
): { readonly all: boolean; readonly rows: ReadonlyArray<AssistantInfoProject> } {
  const busy = new Set(workingNow.map((site) => site.projectId));
  const all = assistant.scope === "all";
  const ids = all ? [...busy] : [...new Set(listedProjects(assistant))];
  return {
    all,
    rows: ids.map((projectId) => ({
      projectId,
      name: nameOf(projectId),
      workingNow: busy.has(projectId),
    })),
  };
}

/** The groups an assistant belongs to, marking the ones it leads. */
export function assistantInfoGroups<
  T extends { readonly team: Pick<AssistantTeam, "memberIds" | "leadId"> },
>(
  teams: ReadonlyArray<T>,
  assistantId: string,
): ReadonlyArray<{ readonly entry: T; readonly lead: boolean }> {
  return teams
    .filter((entry) => entry.team.memberIds.includes(assistantId as Assistant["id"]))
    .map((entry) => ({ entry, lead: entry.team.leadId === assistantId }));
}

/** Every member of a group, a removed one as null so it still counts and shows. Lead first. */
export function assistantGroupMembers<A extends { readonly id: string }>(
  team: Pick<AssistantTeam, "memberIds" | "leadId">,
  assistants: ReadonlyArray<A>,
): ReadonlyArray<{ readonly id: string; readonly assistant: A | null; readonly lead: boolean }> {
  const rows = team.memberIds.map((id) => ({
    id,
    assistant: assistants.find((candidate) => candidate.id === id) ?? null,
    lead: id === team.leadId,
  }));
  return [...rows.filter((row) => row.lead), ...rows.filter((row) => !row.lead)];
}

/** Group info's hero line, from the same members and running tasks its rows list. */
export const assistantGroupInfoSummary = (members: number, running: number) =>
  `${members} members · ${running} running`;
