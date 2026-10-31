import {
  assistantHandleFromName,
  AssistantHandle,
  type Assistant,
  type AssistantsCreateInput,
  type AssistantsUpdateInput,
  type AssistantToolAccess,
  type BudgetPeriod,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderBudget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface AssistantDraft {
  readonly name: string;
  /** Null while it still follows the name. */
  readonly handle: string | null;
  /** Null until chosen; the form then shows the scratch project. */
  readonly projectId: ProjectId | null;
  /** Null until picked; the form then shows the conversation's current or default model. */
  readonly modelSelection: ModelSelection | null;
  readonly instructions: string;
  readonly toolAccess: AssistantToolAccess;
  readonly budget: BudgetDraft;
}

/** The spending limit as typed: amount and warn-at stay text until they are saved. */
export interface BudgetDraft {
  readonly enabled: boolean;
  readonly amount: string;
  readonly period: BudgetPeriod;
  readonly warnAt: string;
  readonly block: boolean;
}

const DEFAULT_BUDGET_DRAFT: BudgetDraft = {
  enabled: false,
  amount: "",
  period: "monthly",
  warnAt: "80",
  block: true,
};

export function budgetDraftFor(budget: ProviderBudget | null | undefined): BudgetDraft {
  return budget
    ? {
        enabled: true,
        amount: String(budget.amountUsd),
        period: budget.period,
        warnAt: String(budget.warnAtPercent),
        block: budget.blockWhenExceeded,
      }
    : DEFAULT_BUDGET_DRAFT;
}

/** Whether the limit can be saved: off, or at least $0.01 and a warn-at from 1 to 100. */
export function isBudgetDraftValid(draft: BudgetDraft): boolean {
  if (!draft.enabled) return true;
  const amount = Number(draft.amount);
  const warnAt = Number(draft.warnAt);
  return (
    draft.amount.trim() !== "" &&
    Number.isFinite(amount) &&
    amount >= 0.01 &&
    Number.isInteger(warnAt) &&
    warnAt >= 1 &&
    warnAt <= 100
  );
}

/** Null when the limit is off. Call only on a valid draft. */
export function budgetFromDraft(
  draft: BudgetDraft,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ProviderBudget | null {
  return draft.enabled
    ? {
        amountUsd: Number(draft.amount),
        period: draft.period,
        warnAtPercent: Number(draft.warnAt),
        blockWhenExceeded: draft.block,
        timeZone,
      }
    : null;
}

function budgetDraftChanged(initial: BudgetDraft, current: BudgetDraft): boolean {
  // A switched-off limit ignores whatever was left in its other fields.
  return !initial.enabled && !current.enabled
    ? false
    : JSON.stringify(initial) !== JSON.stringify(current);
}

export interface AssistantEditor {
  readonly environmentId: EnvironmentId;
  /** Absent when creating. */
  readonly assistant: Assistant | null;
  readonly initial: AssistantDraft;
  readonly current: AssistantDraft;
}

/** The form draft lives in an atom, so it survives while the model picker route is on top. */
export const assistantEditorAtom = Atom.make<AssistantEditor | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:editor"),
);

export function assistantDraftFor(assistant: Assistant | null): AssistantDraft {
  return {
    name: assistant?.name ?? "",
    handle: assistant?.handle ?? null,
    projectId: assistant?.projectId ?? null,
    modelSelection: null,
    instructions: assistant?.instructions ?? "",
    toolAccess: assistant?.toolAccess ?? "full",
    budget: budgetDraftFor(assistant?.budget),
  };
}

export function startAssistantEditor(environmentId: EnvironmentId, assistant: Assistant | null) {
  const draft = assistantDraftFor(assistant);
  appAtomRegistry.set(assistantEditorAtom, {
    environmentId,
    assistant,
    initial: draft,
    current: draft,
  });
}

export function updateAssistantDraft(change: Partial<AssistantDraft>) {
  const editor = appAtomRegistry.get(assistantEditorAtom);
  if (editor) {
    appAtomRegistry.set(assistantEditorAtom, {
      ...editor,
      current: { ...editor.current, ...change },
    });
  }
}

export function discardAssistantEditor() {
  appAtomRegistry.set(assistantEditorAtom, null);
}

export function assistantDraftHasChanges(editor: AssistantEditor): boolean {
  const { budget: initialBudget, ...initial } = editor.initial;
  const { budget: currentBudget, ...current } = editor.current;
  return (
    JSON.stringify(initial) !== JSON.stringify(current) ||
    budgetDraftChanged(initialBudget, currentBudget)
  );
}

const isValidHandle = Schema.is(AssistantHandle);

export function effectiveAssistantHandle(draft: AssistantDraft): string {
  return draft.handle ?? assistantHandleFromName(draft.name) ?? "";
}

export function isAssistantHandleValid(handle: string): boolean {
  return isValidHandle(handle);
}

/** Changing the project starts a new conversation, so the form warns before it saves. */
export function assistantProjectChanged(
  assistant: Assistant | null,
  effectiveProjectId: ProjectId | null,
): boolean {
  return (
    assistant !== null && effectiveProjectId !== null && effectiveProjectId !== assistant.projectId
  );
}

export function assistantCreateInput(
  editor: AssistantEditor,
  effectiveProjectId: ProjectId,
): AssistantsCreateInput {
  const { current } = editor;
  return {
    name: current.name.trim(),
    handle: effectiveAssistantHandle(current),
    projectId: effectiveProjectId,
    ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
    instructions: current.instructions,
    toolAccess: current.toolAccess,
    ...(current.budget.enabled ? { budget: budgetFromDraft(current.budget) } : {}),
  };
}

/** Only what the user changed is sent, so an untouched field never overwrites a newer edit. */
export function assistantUpdateInput(
  editor: AssistantEditor & { readonly assistant: Assistant },
  effectiveProjectId: ProjectId,
): AssistantsUpdateInput {
  const { assistant, current } = editor;
  const name = current.name.trim();
  const handle = effectiveAssistantHandle(current);
  return {
    assistantId: assistant.id,
    ...(name !== assistant.name ? { name } : {}),
    ...(handle !== assistant.handle ? { handle } : {}),
    ...(assistantProjectChanged(assistant, effectiveProjectId)
      ? { projectId: effectiveProjectId }
      : {}),
    ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
    ...(current.instructions !== assistant.instructions
      ? { instructions: current.instructions }
      : {}),
    ...(current.toolAccess !== assistant.toolAccess ? { toolAccess: current.toolAccess } : {}),
    ...(budgetDraftChanged(editor.initial.budget, current.budget)
      ? { budget: budgetFromDraft(current.budget) }
      : {}),
  };
}

/** A new assistant's server is the only part the form can change before it is saved. */
export function changeAssistantEditorEnvironment(environmentId: EnvironmentId) {
  const editor = appAtomRegistry.get(assistantEditorAtom);
  if (editor && editor.assistant === null && editor.environmentId !== environmentId) {
    appAtomRegistry.set(assistantEditorAtom, {
      ...editor,
      environmentId,
      current: { ...editor.current, projectId: null, modelSelection: null },
    });
  }
}
