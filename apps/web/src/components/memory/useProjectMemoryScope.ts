import { useAtomValue } from "@effect/atom-react";
import { memoryProjectScope } from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import type { EnvironmentId, MemoryScope, MemorySpaceId, ProjectId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useProjects } from "../../state/entities";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";

// A space id is stable per environment; one status call per environment is enough.
const spaceByEnvironment = new Map<EnvironmentId, MemorySpaceId>();

/** The environment's local memory space; null until the server reports one. */
export function useMemorySpace(
  environmentId: EnvironmentId | undefined,
  enabled: boolean,
): MemorySpaceId | null {
  const canSync = useAtomValue(memoryEnvironment.syncStatus.permissionAtom(environmentId ?? null));
  const getSync = useAtomCommand(memoryEnvironment.syncStatus, { reportFailure: false });
  const [loaded, setLoaded] = useState<{ environmentId: EnvironmentId; space: MemorySpaceId }>();
  const known =
    environmentId === undefined
      ? null
      : (spaceByEnvironment.get(environmentId) ??
        (loaded?.environmentId === environmentId ? loaded.space : null));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's memory space from the server
  useEffect(() => {
    if (!enabled || !canSync || environmentId === undefined || known !== null) return;
    let current = true;
    void getSync({ environmentId, input: {} }).then((result) => {
      const space = result._tag === "Success" ? memoryLocalSpace(result.value) : null;
      if (!space) return;
      spaceByEnvironment.set(environmentId, space);
      if (current) setLoaded({ environmentId, space });
    });
    return () => {
      current = false;
    };
  }, [canSync, enabled, environmentId, getSync, known]);
  return enabled && canSync ? known : null;
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

/**
 * The project's memory scope, whose shared key needs a binding lookup; null without a project.
 * A new `attempt` looks the key up again.
 */
export function useProjectMemoryScope(
  environmentId: EnvironmentId | undefined,
  projectId: ProjectId | null,
  space: MemorySpaceId | null,
  attempt = 0,
): ProjectMemoryScope | null {
  const projects = useProjects();
  const canBind = useAtomValue(
    memoryEnvironment.projectBindingGet.permissionAtom(environmentId ?? null),
  );
  const getBinding = useAtomCommand(memoryEnvironment.projectBindingGet, { reportFailure: false });
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const repositoryIdentity = projects.find(
    (project) => project.environmentId === environmentId && project.id === projectId,
  )?.repositoryIdentity;
  const key = `${environmentId}:${projectId}:${space}:${attempt}`;
  const wanted = environmentId !== undefined && projectId !== null && canBind && space !== null;
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
  if (environmentId === undefined || projectId === null) return null;
  if (!canBind) return { status: "no-permission" };
  return resolved?.key === key ? resolved.scope : { status: "loading" };
}
