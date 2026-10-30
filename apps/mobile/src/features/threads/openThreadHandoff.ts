import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { whenRootNavigationReady, rootNavigationRef } from "../../lib/rootNavigation";

/** For menus outside the thread route, such as the thread list. */
export function openThreadHandoff(thread: EnvironmentThreadShell): void {
  whenRootNavigationReady(() =>
    rootNavigationRef.navigate("ThreadHandoff", {
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
}
