export const ARCHIVE_PROJECT_ACTION_ID = "archive-project";
export const PROJECT_SETTINGS_ACTION_ID = "project-settings";

/** What the selected project's menu entries do; a missing one is not offered from here. */
export interface SelectedProjectActions {
  readonly openSettings?: (() => unknown) | undefined;
  readonly archive?: (() => unknown) | undefined;
}

/** The menu entries for the selected project: its settings, then archiving it. */
export function selectedProjectMenuActions(
  project: { readonly label: string } | undefined,
  actions: SelectedProjectActions,
) {
  if (!project) return [];
  return [
    ...(actions.openSettings
      ? [
          {
            id: PROJECT_SETTINGS_ACTION_ID,
            title: "Project settings",
            subtitle: project.label,
            image: "gearshape",
          },
        ]
      : []),
    ...(actions.archive
      ? [
          {
            id: ARCHIVE_PROJECT_ACTION_ID,
            title: "Archive project",
            subtitle: project.label,
            image: "archivebox",
          },
        ]
      : []),
  ];
}

/** Runs the selected project's entry when `id` is one; false leaves the id to the menu's other actions. */
export function runSelectedProjectAction(id: string, actions: SelectedProjectActions) {
  if (id === PROJECT_SETTINGS_ACTION_ID) actions.openSettings?.();
  else if (id === ARCHIVE_PROJECT_ACTION_ID) actions.archive?.();
  else return false;
  return true;
}
