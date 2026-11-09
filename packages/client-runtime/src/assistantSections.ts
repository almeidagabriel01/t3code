import type { Assistant, AssistantTeam, ProjectId } from "@t3tools/contracts";

export interface SectionAssistant {
  readonly environmentId: string;
  readonly assistant: Pick<Assistant, "id" | "scope" | "projectId"> & {
    /** Absent from a server that predates project lists: its one project is the list. */
    readonly projectIds?: Assistant["projectIds"];
  };
}

export interface SectionTeam {
  readonly environmentId: string;
  readonly team: Pick<AssistantTeam, "id" | "memberIds">;
}

/** The projects a project assistant belongs to. */
export const listedProjects = (
  assistant: SectionAssistant["assistant"],
): ReadonlyArray<ProjectId> =>
  assistant.projectIds === undefined || assistant.projectIds.length === 0
    ? [assistant.projectId]
    : assistant.projectIds;

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
 * is under each group it belongs to, otherwise under each project on its list (project scope) or unassigned.
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
    for (const projectId of listedProjects(entry.assistant)) {
      const key = `${entry.environmentId}:${projectId}`;
      const bucket = projects.get(key) ?? {
        environmentId: entry.environmentId,
        projectId,
        members: [],
      };
      bucket.members.push(entry);
      projects.set(key, bucket);
    }
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
          member.environmentId === environmentId &&
          (listedProjects(assistant) as ReadonlyArray<string>).includes(member.projectId),
      ),
  );
}

/** Where an assistant works, for labels: "All projects" for scope `all` (its home folder is not the answer). */
export const assistantProjectsLabel = (
  assistant: SectionAssistant["assistant"],
  nameOf: (projectId: string) => string,
): string =>
  assistant.scope === "all" ? "All projects" : listedProjects(assistant).map(nameOf).join(", ");

/** The picker's "All projects" entry: always offered, and the assistant's scope `all`. */
export const ALL_PROJECTS = "all";

/** What the project picker starts on: "All projects", or the assistant's list. */
export const assistantProjectSelection = (
  assistant: SectionAssistant["assistant"],
): ReadonlyArray<string> =>
  assistant.scope === "all" ? [ALL_PROJECTS] : listedProjects(assistant);

/** A pick of several projects. "All projects" is exclusive, and clearing the last project falls back to it. */
export const toggleAssistantProject = (
  current: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> => {
  if (id === ALL_PROJECTS) return [id];
  const rest = current.filter((entry) => entry !== ALL_PROJECTS && entry !== id);
  const next = current.includes(id) ? rest : [...rest, id];
  return next.length === 0 ? [ALL_PROJECTS] : next;
};

/** The home project after a save: the current one while it stays picked, else the first picked project. */
export const homeAfterPick = <T extends string>(current: T | null, picked: ReadonlyArray<T>) => {
  const projects = picked.filter((id) => id !== ALL_PROJECTS);
  if (projects.length === 0) return current;
  return current !== null && projects.includes(current) ? current : projects[0]!;
};

/**
 * The fields that carry a pick: "All projects" is scope `all` (the server picks the home; `home` is
 * only the required placeholder), one project is `projectId`, several add the list.
 */
export const assistantProjectFields = <T extends string>(
  picked: ReadonlyArray<T>,
  home: T,
):
  | { readonly projectId: T; readonly scope: "all" }
  | { readonly projectId: T; readonly projectIds?: ReadonlyArray<T> } =>
  picked.includes(ALL_PROJECTS as T)
    ? { projectId: home, scope: "all" }
    : { projectId: picked[0]!, ...(picked.length > 1 ? { projectIds: picked } : {}) };

/** Picker rows, "All projects" first. A label shared by several rows gets its folder as `detail`. */
export const projectPickerRows = (
  projects: ReadonlyArray<{ readonly id: string; readonly label: string; readonly path: string }>,
): ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
}> => {
  const counts = new Map<string, number>();
  for (const { label } of projects) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [
    { id: ALL_PROJECTS, label: "All projects", detail: null },
    ...projects.map(({ id, label, path }) => ({
      id,
      label,
      detail: (counts.get(label) ?? 0) > 1 ? path : null,
    })),
  ];
};

export const sameProjects = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id) => b.includes(id));
