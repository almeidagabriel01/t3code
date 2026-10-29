import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { NoteFolder, ProjectId } from "@t3tools/contracts";

export interface WorkProjectOption {
  readonly value: ProjectId;
  readonly label: string;
}

const folderName = (value: string) => value.normalize("NFC").toLocaleLowerCase();

/**
 * The project a note's work most likely belongs to: one named like the note's folder, else the
 * one most recently active.
 */
export function defaultWorkProject(
  projects: ReadonlyArray<EnvironmentProject>,
  folder: NoteFolder | null,
  recent: ReadonlyArray<ProjectId>,
): ProjectId | null {
  const named =
    folder === null
      ? undefined
      : projects.find((project) => folderName(project.title) === folderName(folder));
  if (named) return named.id;
  const known = new Set(projects.map((project) => project.id));
  const latest = recent.find((id) => known.has(id));
  if (latest) return latest;
  return (
    projects.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? null
  );
}

/** Project titles, with the folder path added where two projects share a title. */
export function workProjectOptions(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<WorkProjectOption> {
  const counts = new Map<string, number>();
  for (const project of projects) counts.set(project.title, (counts.get(project.title) ?? 0) + 1);
  return projects
    .toSorted((left, right) => left.title.localeCompare(right.title))
    .map((project) => ({
      value: project.id,
      label:
        (counts.get(project.title) ?? 0) > 1
          ? `${project.title} · ${project.workspaceRoot}`
          : project.title,
    }));
}
