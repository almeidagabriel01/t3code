import { useAtomValue } from "@effect/atom-react";
import { memoryProjectScope } from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import type { EnvironmentId, MemoryScope, MemorySpaceId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useProjects } from "../../state/entities";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";

/** The environment's local memory space; null until the server reports one. */
export function useMemorySpace(
  environmentId: EnvironmentId,
  enabled: boolean,
): MemorySpaceId | null {
  const canSync = useAtomValue(memoryEnvironment.syncStatus.permissionAtom(environmentId));
  const getSync = useAtomCommand(memoryEnvironment.syncStatus, { reportFailure: false });
  const [space, setSpace] = useState<MemorySpaceId | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's memory space from the server
  useEffect(() => {
    if (!enabled || !canSync) return;
    let current = true;
    void getSync({ environmentId, input: {} }).then((result) => {
      if (current && result._tag === "Success") setSpace(memoryLocalSpace(result.value));
    });
    return () => {
      current = false;
    };
  }, [canSync, enabled, environmentId, getSync]);
  return space;
}

export type ProjectMemoryScope =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly scope: MemoryScope }
  /** The lookup needs memory write permission. */
  | { readonly status: "no-permission" }
  /** No repository and no explicit shared key, so the project has no memory of its own. */
  | { readonly status: "no-key" }
  | { readonly status: "failed" };

type Resolved = { readonly key: string; readonly scope: ProjectMemoryScope };

/** The project's memory scope, whose shared key needs a binding lookup; null without a project. */
export function useProjectMemoryScope(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
  space: MemorySpaceId | null,
): ProjectMemoryScope | null {
  const projects = useProjects();
  const canBind = useAtomValue(memoryEnvironment.projectBindingGet.permissionAtom(environmentId));
  const getBinding = useAtomCommand(memoryEnvironment.projectBindingGet, { reportFailure: false });
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const repositoryIdentity = projects.find(
    (project) => project.environmentId === environmentId && project.id === projectId,
  )?.repositoryIdentity;
  const key = `${environmentId}:${projectId}:${space}`;
  const wanted = projectId !== null && canBind && space !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project's shared memory key from the server
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void getBinding({
      environmentId,
      input: { memorySpaceId: space, project: { environmentId, projectId } },
    }).then((result) => {
      if (!current) return;
      const scope =
        result._tag === "Success" ? memoryProjectScope(result.value, repositoryIdentity) : null;
      setResolved({
        key,
        scope:
          result._tag !== "Success"
            ? { status: "failed" }
            : scope === null
              ? { status: "no-key" }
              : { status: "ready", scope },
      });
    });
    return () => {
      current = false;
    };
  }, [environmentId, getBinding, key, projectId, repositoryIdentity, space, wanted]);
  if (projectId === null) return null;
  if (!canBind) return { status: "no-permission" };
  return resolved?.key === key ? resolved.scope : { status: "loading" };
}
