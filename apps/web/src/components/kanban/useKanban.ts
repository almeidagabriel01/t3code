import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { KanbanState } from "@t3tools/client-runtime/state/kanban";
import {
  CommandId,
  type EnvironmentId,
  type KanbanBoardEnsureInput,
  type KanbanBoardUpdateInput,
  type KanbanCardCommentInput,
  type KanbanCardCreateInput,
  type KanbanCardIdInput,
  type KanbanCardMoveInput,
  type KanbanCardThreadLinkInput,
  type KanbanCardUpdateInput,
  type KanbanColumnCreateInput,
  type KanbanColumnDeleteInput,
  type KanbanColumnMoveInput,
  type KanbanColumnUpdateInput,
  type KanbanLabelDeleteInput,
  type KanbanLabelUpsertInput,
  type KanbanMutationResult,
  type KanbanTemplateDeleteInput,
  type KanbanTemplateUpsertInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { randomUUID } from "../../lib/utils";
import { environmentIdsKey } from "../../state/environmentAtomList";
import { kanbanEnvironment, kanbanLiveListAtom, useKanbanEnvironmentIds } from "../../state/kanban";
import { stackedThreadToast, toastManager } from "../ui/toast";

type Without<T> = Omit<T, "commandId" | "actor">;

export function reportKanbanError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function useKanbanActions(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const run = async <W, E>(
    command: AtomCommand<W, KanbanMutationResult, E>,
    input: Omit<W extends { input: infer I } ? I : never, "commandId">,
    title: string,
  ): Promise<KanbanMutationResult | null> => {
    const value = { environmentId, input: { commandId: CommandId.make(randomUUID()), ...input } };
    const result = await runAtomCommand(registry, command, value as W);
    if (AsyncResult.isSuccess(result)) return result.value;
    if (!isAtomCommandInterrupted(result))
      reportKanbanError(title, squashAtomCommandFailure(result));
    return null;
  };
  const k = kanbanEnvironment;
  return {
    ensureBoard: (input: Without<KanbanBoardEnsureInput>) =>
      run(k.ensureBoard, input, "Could not open board"),
    updateBoard: (input: Without<KanbanBoardUpdateInput>) =>
      run(k.updateBoard, input, "Could not update board"),
    createColumn: (input: Without<KanbanColumnCreateInput>) =>
      run(k.createColumn, input, "Could not add column"),
    updateColumn: (input: Without<KanbanColumnUpdateInput>) =>
      run(k.updateColumn, input, "Could not update column"),
    moveColumn: (input: Without<KanbanColumnMoveInput>) =>
      run(k.moveColumn, input, "Could not move column"),
    deleteColumn: (input: Without<KanbanColumnDeleteInput>) =>
      run(k.deleteColumn, input, "Could not delete column"),
    upsertLabel: (input: Without<KanbanLabelUpsertInput>) =>
      run(k.upsertLabel, input, "Could not save label"),
    deleteLabel: (input: Without<KanbanLabelDeleteInput>) =>
      run(k.deleteLabel, input, "Could not delete label"),
    upsertTemplate: (input: Without<KanbanTemplateUpsertInput>) =>
      run(k.upsertTemplate, input, "Could not save template"),
    deleteTemplate: (input: Without<KanbanTemplateDeleteInput>) =>
      run(k.deleteTemplate, input, "Could not delete template"),
    createCard: (input: Without<KanbanCardCreateInput>) =>
      run(k.createCard, input, "Could not create card"),
    updateCard: (input: Without<KanbanCardUpdateInput>) =>
      run(k.updateCard, input, "Could not update card"),
    moveCard: (input: Without<KanbanCardMoveInput>) =>
      run(k.moveCard, input, "Could not move card"),
    archiveCard: (input: Without<KanbanCardIdInput>) =>
      run(k.archiveCard, input, "Could not archive card"),
    unarchiveCard: (input: Without<KanbanCardIdInput>) =>
      run(k.unarchiveCard, input, "Could not restore card"),
    deleteCard: (input: Without<KanbanCardIdInput>) =>
      run(k.deleteCard, input, "Could not delete card"),
    commentOnCard: (input: Without<KanbanCardCommentInput>) =>
      run(k.commentOnCard, input, "Could not add comment"),
    linkCardThread: (input: Without<KanbanCardThreadLinkInput>) =>
      run(k.linkCardThread, input, "Could not link thread"),
    unlinkCardThread: (input: Without<KanbanCardThreadLinkInput>) =>
      run(k.unlinkCardThread, input, "Could not unlink thread"),
  };
}

export function useKanbanCanEdit(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(kanbanEnvironment.createCard.permissionAtom(environmentId));
}

export interface KanbanEnvironmentState {
  readonly environmentId: EnvironmentId;
  readonly state: KanbanState | null;
  readonly error: string | null;
}

/** One entry per connected environment that supports boards, with its live state once it arrives. */
export function useKanbanStates(): ReadonlyArray<KanbanEnvironmentState> {
  const ids = useKanbanEnvironmentIds();
  const results = useAtomValue(kanbanLiveListAtom(environmentIdsKey(ids)));
  return ids.map((environmentId, index) => {
    const result = results[index]!;
    return {
      environmentId,
      state: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? "Could not load boards." : null,
    };
  });
}
