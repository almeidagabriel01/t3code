export const ARCHIVE_PROJECT_ACTION_ID = "archive-project";

/** The menu entry that hides the selected project, or nothing when it cannot be archived. */
export function archiveProjectMenuActions(project: { readonly label: string } | undefined) {
  return project
    ? [{ id: ARCHIVE_PROJECT_ACTION_ID, title: "Archive project", subtitle: project.label }]
    : [];
}
