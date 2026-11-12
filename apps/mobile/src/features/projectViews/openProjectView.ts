import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { projectViewCommands, projectViewsFor, type ProjectView } from "./projectViews";

type ThreadTarget = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

/** Opens the thread's project sheet, on `view` or else its first section. */
export function openProjectView(thread: ThreadTarget, view?: ProjectView) {
  whenRootNavigationReady(() =>
    rootNavigationRef.navigate("ThreadProjectView", {
      environmentId: thread.environmentId,
      threadId: thread.id,
      ...(view === undefined ? {} : { view }),
    }),
  );
}

/** Command palette entries that open the thread's project sheet on each section it offers. */
export function projectViewPaletteActions(
  thread: ThreadTarget,
  project: { readonly environmentId: EnvironmentId; readonly title: string },
  kanbanEnvironmentIds: ReadonlyArray<EnvironmentId>,
) {
  const views = projectViewsFor(kanbanEnvironmentIds.includes(project.environmentId));
  return projectViewCommands(views, project.title).map((command) => ({
    ...command,
    kind: "action" as const,
    run: () => openProjectView(thread, command.view),
  }));
}
