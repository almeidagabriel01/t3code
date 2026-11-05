import type { EnvironmentProject } from "../state/models.ts";
import { projectPickerLabels } from "../projectLabels.ts";
import { projectNoteFolder } from "./title.ts";
import type { NoteFolder, ProjectId } from "@t3tools/contracts";

export interface WorkProjectOption {
  readonly value: ProjectId;
  readonly label: string;
}

/** Stands for the No-project board until its Scratch project is ensured at start. */
export const NO_PROJECT_WORK = "no-project" as ProjectId;

const folderName = (value: string) => value.normalize("NFC").toLocaleLowerCase();
const projectFolderName = (title: string) => folderName(projectNoteFolder(title) ?? title);

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
      : projects.find((project) => projectFolderName(project.title) === folderName(folder));
  if (named) return named.id;
  const known = new Set(projects.map((project) => project.id));
  const latest = recent.find((id) => known.has(id));
  if (latest) return latest;
  return (
    [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ??
    null
  );
}

/** Project titles, with the folder path added where two projects share a title. */
export function workProjectOptions(
  projects: ReadonlyArray<EnvironmentProject>,
  offerNoProject = false,
): ReadonlyArray<WorkProjectOption> {
  const labels = projectPickerLabels(projects);
  const named = projects
    .map((project, index) => ({ value: project.id, label: labels[index] ?? project.title }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return offerNoProject ? [{ value: NO_PROJECT_WORK, label: "No project" }, ...named] : named;
}
