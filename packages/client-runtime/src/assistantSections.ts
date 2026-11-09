import type { Assistant, AssistantTeam } from "@t3tools/contracts";

export interface SectionAssistant {
  readonly environmentId: string;
  readonly assistant: Pick<Assistant, "id" | "scope" | "projectId">;
}

export interface SectionTeam {
  readonly environmentId: string;
  readonly team: Pick<AssistantTeam, "id" | "memberIds">;
}

export const assistantEntryKey = (entry: SectionAssistant) =>
  `${entry.environmentId}:${entry.assistant.id}`;

export interface AssistantSections<A extends SectionAssistant, T extends SectionTeam> {
  readonly needs: ReadonlyArray<A>;
  /** Every group, empty ones too; an assistant in several groups is listed under each. */
  readonly groups: ReadonlyArray<{ readonly team: T; readonly members: ReadonlyArray<A> }>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectId: string;
    readonly members: ReadonlyArray<A>;
  }>;
  readonly unassigned: ReadonlyArray<A>;
}

/**
 * Where each active assistant is listed. One that needs the user shows only under `needs`; else it
 * is under each group it belongs to, otherwise under its project (project scope) or unassigned.
 */
export function assistantSections<A extends SectionAssistant, T extends SectionTeam>(input: {
  readonly assistants: ReadonlyArray<A>;
  readonly teams: ReadonlyArray<T>;
  /** `assistantEntryKey` of every assistant whose mood is "needs". */
  readonly needsKeys: ReadonlySet<string>;
}): AssistantSections<A, T> {
  const needs = input.assistants.filter((entry) => input.needsKeys.has(assistantEntryKey(entry)));
  const rest = input.assistants.filter((entry) => !input.needsKeys.has(assistantEntryKey(entry)));
  const byKey = new Map(rest.map((entry) => [assistantEntryKey(entry), entry] as const));
  const grouped = new Set<string>();
  const groups = input.teams.map((team) => {
    const members = team.team.memberIds.flatMap((id) => {
      const key = `${team.environmentId}:${id}`;
      const entry = byKey.get(key);
      if (entry === undefined) return [];
      grouped.add(key);
      return [entry];
    });
    return { team, members };
  });
  const projects = new Map<string, { environmentId: string; projectId: string; members: A[] }>();
  const unassigned: A[] = [];
  for (const entry of rest) {
    if (grouped.has(assistantEntryKey(entry))) continue;
    if (entry.assistant.scope !== "project") {
      unassigned.push(entry);
      continue;
    }
    const key = `${entry.environmentId}:${entry.assistant.projectId}`;
    const bucket = projects.get(key) ?? {
      environmentId: entry.environmentId,
      projectId: entry.assistant.projectId,
      members: [],
    };
    bucket.members.push(entry);
    projects.set(key, bucket);
  }
  return { needs, groups, projects: [...projects.values()], unassigned };
}

/** The project-scoped assistants of any of `members` (a project can span environments). */
export function projectAssistants<A extends SectionAssistant>(
  assistants: ReadonlyArray<A>,
  members: ReadonlyArray<{ readonly environmentId: string; readonly projectId: string }>,
): ReadonlyArray<A> {
  return assistants.filter(
    ({ environmentId, assistant }) =>
      assistant.scope === "project" &&
      members.some(
        (member) =>
          member.environmentId === environmentId && member.projectId === assistant.projectId,
      ),
  );
}
