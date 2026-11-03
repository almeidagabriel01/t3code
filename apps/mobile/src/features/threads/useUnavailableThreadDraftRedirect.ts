import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";

/** Replaces this thread route with a new draft for the environment's project, once on mount. */
export function useUnavailableThreadDraftRedirect(environmentId: EnvironmentId) {
  const navigation = useNavigation();
  const projects = useProjects();
  const openDraft = useEffectEvent(() => {
    // A screen already leaving the stack (replaced, then its thread deleted) must not replace the new one.
    if (!navigation.isFocused()) return;
    const project = projects.find((candidate) => candidate.environmentId === environmentId);
    navigation.dispatch(
      StackActions.replace("Thread", {
        draft: project
          ? {
              requestId: uuidv4(),
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            }
          : { requestId: uuidv4() },
      }),
    );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replaces this route with a new draft thread route for the environment's project on mount
  useEffect(() => {
    openDraft();
  }, []);
}
