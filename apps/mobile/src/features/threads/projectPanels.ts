import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";

/** Opens a project page over the thread, so going back returns to it. */
export function openProjectPanel(
  route: "SettingsProjectKanban" | "SettingsProjectScheduledTasks",
  thread: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
) {
  whenRootNavigationReady(() =>
    rootNavigationRef.navigate(route, {
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    }),
  );
}
