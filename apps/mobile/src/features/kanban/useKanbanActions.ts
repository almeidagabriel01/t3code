import { useAtomValue } from "@effect/atom-react";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type EnvironmentId, type KanbanMutationResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { uuidv4 } from "../../lib/uuid";
import { kanbanEnvironment } from "../../state/kanban";
import { useAtomCommand } from "../../state/use-atom-command";

interface KanbanCommandValue {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly commandId: CommandId };
}

/** Failures are reported by the command; the promise resolves to whether the server accepted it. */
function useKanbanCommand<W extends KanbanCommandValue, E>(
  command: AtomCommand<W, KanbanMutationResult, E>,
  environmentId: EnvironmentId,
) {
  const run = useAtomCommand(command);
  return async (input: Omit<W["input"], "commandId" | "actor">) =>
    AsyncResult.isSuccess(
      await run({
        environmentId,
        input: { commandId: CommandId.make(uuidv4()), ...input },
      } as W),
    );
}

export function useKanbanActions(environmentId: EnvironmentId) {
  return {
    canEdit: useAtomValue(kanbanEnvironment.createCard.permissionAtom(environmentId)),
    createCard: useKanbanCommand(kanbanEnvironment.createCard, environmentId),
    updateCard: useKanbanCommand(kanbanEnvironment.updateCard, environmentId),
    moveCard: useKanbanCommand(kanbanEnvironment.moveCard, environmentId),
    commentOnCard: useKanbanCommand(kanbanEnvironment.commentOnCard, environmentId),
    archiveCard: useKanbanCommand(kanbanEnvironment.archiveCard, environmentId),
    unarchiveCard: useKanbanCommand(kanbanEnvironment.unarchiveCard, environmentId),
    deleteCard: useKanbanCommand(kanbanEnvironment.deleteCard, environmentId),
    linkCardThread: useKanbanCommand(kanbanEnvironment.linkCardThread, environmentId),
    unlinkCardThread: useKanbanCommand(kanbanEnvironment.unlinkCardThread, environmentId),
  };
}
