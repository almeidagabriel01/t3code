import { squashAtomCommandFailure, type AtomCommand } from "@t3tools/client-runtime/state/runtime";

import { useAtomCommand } from "../../state/use-atom-command";
import type { NoteReply } from "./noteState";

/** Runs a notes command and settles into a reply; callers show failures where they happened. */
export function useNoteCommand<W, A, E>(command: AtomCommand<W, A, E>) {
  const run = useAtomCommand(command, { reportFailure: false });
  return async (input: W): Promise<NoteReply<A>> => {
    const result = await run(input);
    return result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, error: squashAtomCommandFailure(result) };
  };
}
