import type { AssistantId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export type AssistantWorkTarget = {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
};

/**
 * Which assistant's Work panel is open. The assistants page, the sidebar and the thread menu open
 * it, so the root renders it once.
 */
export const assistantWorkAtom = Atom.make<AssistantWorkTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:work"),
);

export function openAssistantWork(target: AssistantWorkTarget): void {
  appAtomRegistry.set(assistantWorkAtom, target);
}
