import type { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type AssistantDialogTarget = {
  readonly environmentId: EnvironmentId | null;
  /** Absent when creating. */
  readonly assistantId: AssistantId | null;
};

/**
 * Which assistant the create/edit dialog is open for. The sidebar, the palette, the thread menu
 * and Settings all open it, so the root renders it once.
 */
export const assistantDialogAtom = Atom.make<AssistantDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:dialog"),
);

export function openAssistantDialog(target: Partial<AssistantDialogTarget> = {}): void {
  appAtomRegistry.set(assistantDialogAtom, {
    environmentId: target.environmentId ?? null,
    assistantId: target.assistantId ?? null,
  });
}
