import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
  isProviderWorkspaceSnapshotScanning,
  type ProviderWorkspaceSnapshotRefreshState,
} from "@t3tools/client-runtime/providerSkills";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

const providerWorkspaceSnapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idleRefreshAtom: Atom.Atom<ProviderWorkspaceSnapshotRefreshState | undefined> = Atom.make<
  ProviderWorkspaceSnapshotRefreshState | undefined
>(undefined).pipe(Atom.withLabel("provider-workspace-snapshot-refresh:idle"));

/**
 * Keeps the selected provider's workspace snapshot fresh for the composer's
 * cwd while mounted. Returns the cwd whose catalog to read, a check to run when
 * the user types, and whether the cwd's skills are still being scanned.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly instanceId: ProviderInstanceId | undefined;
}): { readonly cwd: string | null; readonly refresh: () => void; readonly scanning: boolean } {
  const { environmentId, gitCwd, instanceId } = input;
  // The config carries only names, so a draft with no project yet reads the scratch folder's catalog.
  const scratchRoot = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.scratchWorkspaceRoot ?? null,
  );
  const cwd = gitCwd ?? scratchRoot;
  const atom =
    cwd && instanceId
      ? providerWorkspaceSnapshotRefresh({ environmentId, instanceId, cwd })
      : idleRefreshAtom;
  return {
    cwd,
    refresh: useAtomRefresh(atom),
    scanning: isProviderWorkspaceSnapshotScanning(useAtomValue(atom)),
  };
}
