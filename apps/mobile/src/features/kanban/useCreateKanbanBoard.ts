import { boardScopeKey } from "@t3tools/client-runtime/state/kanbanLogic";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { kanbanEnvironment } from "../../state/kanban";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import type { NewBoardTarget } from "./kanbanBoardView";

/** Same as web: the server creates a project's board on first open. Resolves to the board's scope key. */
export function useCreateKanbanBoard() {
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const ensureBoard = useAtomCommand(kanbanEnvironment.ensureBoard);
  return async ({ environmentId, projectId }: NewBoardTarget): Promise<string | null> => {
    let id = projectId;
    if (id === null) {
      const scratch = await openScratch({ environmentId, input: {} });
      if (scratch._tag !== "Success") {
        if (!isAtomCommandInterrupted(scratch)) {
          const failure = squashAtomCommandFailure(scratch);
          Dialog.alert(
            "Could not create the board",
            failure instanceof Error ? failure.message : "This machine has no No project folder.",
          );
        }
        return null;
      }
      id = scratch.value.id;
    }
    const result = await ensureBoard({
      environmentId,
      input: { commandId: CommandId.make(uuidv4()), projectId: id },
    });
    return AsyncResult.isSuccess(result) ? boardScopeKey(environmentId, id) : null;
  };
}
