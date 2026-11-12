import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import type { ProjectView } from "./projectViews";

/** Opens the thread's project sheet, on `view` or else its first section. */
export function openProjectView(
  thread: { readonly environmentId: EnvironmentId; readonly id: ThreadId },
  view?: ProjectView,
) {
  whenRootNavigationReady(() =>
    rootNavigationRef.navigate("ThreadProjectView", {
      environmentId: thread.environmentId,
      threadId: thread.id,
      ...(view === undefined ? {} : { view }),
    }),
  );
}
