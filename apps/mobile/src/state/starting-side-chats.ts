import type { ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

interface StartingSideChat {
  readonly prompt: string;
  readonly error: string | null;
  /** Created with its message; the screen keeps the message until the thread's detail has it. */
  readonly started?: true;
}

/** Side chats whose screen is open while the server still creates them, by thread id. */
export const startingSideChatsAtom = Atom.make<Readonly<Record<string, StartingSideChat>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:starting-side-chats"),
);

/** Shows `value` on the side chat's screen until it starts. */
export function setStartingSideChat(threadId: ThreadId, value: StartingSideChat | null): void {
  const { [threadId]: _dropped, ...rest } = appAtomRegistry.get(startingSideChatsAtom);
  appAtomRegistry.set(
    startingSideChatsAtom,
    value === null ? rest : { ...rest, [threadId]: value },
  );
}

/** A side chat the server may not have yet: loading its detail now would cache it as deleted. */
export const sideChatNotCreatedYet = (value: StartingSideChat | undefined) =>
  value !== undefined && value.error === null && value.started !== true;
