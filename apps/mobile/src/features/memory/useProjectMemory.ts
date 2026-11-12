import { useAtomValue } from "@effect/atom-react";
import { memoryProjectScope } from "@t3tools/client-runtime/memory-browsing";
import { memoryLocalSpace } from "@t3tools/client-runtime/memory-presentation";
import {
  MemoryOperationId,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
} from "@t3tools/contracts";
import * as Crypto from "expo-crypto";
import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useProjects } from "../../state/entities";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { memoryExpectedHeads } from "../settings/SettingsMemoryRouteScreen.logic";

/** The environment's local memory space; null until the server reports one. */
export function useMemorySpace(
  environmentId: EnvironmentId,
  enabled: boolean,
): MemorySpaceId | null {
  const canSync = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const getSync = useAtomCommand(memory.syncStatus, { reportFailure: false });
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
  projectId: string | null,
  space: MemorySpaceId | null,
): ProjectMemoryScope | null {
  const projects = useProjects();
  const canBind = useAtomValue(memory.projectBindingGet.permissionAtom(environmentId));
  const getBinding = useAtomCommand(memory.projectBindingGet, { reportFailure: false });
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const repositoryIdentity = project?.repositoryIdentity;
  const knownProjectId = project?.id;
  const key = `${environmentId}:${projectId}:${space}`;
  const wanted = canBind && space !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the project's shared memory key from the server
  useEffect(() => {
    if (!wanted || knownProjectId === undefined) return;
    let current = true;
    void getBinding({
      environmentId,
      input: { memorySpaceId: space, project: { environmentId, projectId: knownProjectId } },
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
  }, [environmentId, getBinding, key, knownProjectId, repositoryIdentity, space, wanted]);
  if (projectId === null) return null;
  if (!canBind) return { status: "no-permission" };
  return resolved?.key === key ? resolved.scope : { status: "loading" };
}

/** Forgets a memory after a confirmation; the keyboard closes first so it cannot linger behind it. */
export function useForgetMemory(environmentId: EnvironmentId) {
  const forget = useAtomCommand(memory.forget, { reportFailure: false });
  return (item: MemoryItem) => {
    Keyboard.dismiss();
    Dialog.confirm({
      title: "Forget this memory?",
      message: "This cannot be undone.",
      confirmText: "Forget",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const result = await forget({
            environmentId,
            input: {
              memorySpaceId: item.memorySpaceId,
              memoryId: item.memoryId,
              expectedHeads: memoryExpectedHeads(item),
              operationId: MemoryOperationId.make(Crypto.randomUUID()),
            },
          });
          if (result._tag === "Failure" || result.value.outcome === "rejected")
            Dialog.alert(
              "Could not forget this memory",
              "Open it in Memory to review the record before trying again.",
            );
        })();
      },
    });
  };
}
