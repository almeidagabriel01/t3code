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

export function openAssistantTeamDialog(target: Partial<AssistantTeamDialogTarget> = {}): void {
  appAtomRegistry.set(assistantTeamDialogAtom, {
    environmentId: target.environmentId ?? null,
    teamId: target.teamId ?? null,
  });
}

export type AssistantGroupSettingsTarget = {
  readonly environmentId: EnvironmentId;
  readonly teamId: AssistantTeamId;
};

/** A group's settings dialog; the chat header and the sidebar row open it. */
export const assistantGroupSettingsAtom = Atom.make<AssistantGroupSettingsTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:group-settings"),
);

export function openAssistantGroupSettings(target: AssistantGroupSettingsTarget): void {
  appAtomRegistry.set(assistantGroupSettingsAtom, target);
}
