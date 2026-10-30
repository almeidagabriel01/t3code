import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Which thread has the hand-off dialog open. The header, thread menu and palette all open it. */
export const threadHandoffDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-handoff:dialog-thread"),
);

export function openThreadHandoffDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadHandoffDialogAtom, threadRef);
}
