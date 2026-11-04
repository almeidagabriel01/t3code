export const ARCHIVE_PROJECT_ACTION_ID = "archive-project";

/** The menu entry that hides the selected project; nothing when it cannot be archived from here. */
export function archiveProjectMenuActions(
  project: { readonly label: string } | undefined,
  archive: (() => unknown) | undefined,
) {
  return project && archive
    ? [{ id: ARCHIVE_PROJECT_ACTION_ID, title: "Archive project", subtitle: project.label }]
    : [];
}

/** Runs the archive entry when `id` is it; false leaves the id to the menu's other actions. */
export function runArchiveProjectAction(id: string, archive: (() => unknown) | undefined) {
  if (id !== ARCHIVE_PROJECT_ACTION_ID) return false;
  archive?.();
  return true;
}
