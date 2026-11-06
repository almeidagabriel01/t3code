import type { AssistantTeamId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type AssistantTeamDialogTarget = {
  readonly environmentId: EnvironmentId | null;
  /** Absent when creating. */
  readonly teamId: AssistantTeamId | null;
};

/** The team create/edit dialog; Settings opens it, so the root renders it once. */
export const assistantTeamDialogAtom = Atom.make<AssistantTeamDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:team-dialog"),
);

/** The team activity view; Settings and the sidebar open it. */
export const assistantTeamActivityAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("assistants:team-activity"));

export function openAssistantTeamDialog(target: Partial<AssistantTeamDialogTarget> = {}): void {
  appAtomRegistry.set(assistantTeamDialogAtom, {
    environmentId: target.environmentId ?? null,
    teamId: target.teamId ?? null,
  });
}

export function openAssistantTeamActivity(environmentId: EnvironmentId, teamId: AssistantTeamId) {
  appAtomRegistry.set(assistantTeamActivityAtom, { environmentId, teamId });
}
