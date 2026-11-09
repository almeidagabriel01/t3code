import {
  connectorDraftsFrom,
  connectorInputsFrom,
  connectorsEqual,
  type ConnectorDraft,
} from "@t3tools/client-runtime/assistantConnectors";
import { assistantRobotLook, newAssistantLook } from "@t3tools/client-runtime/assistantRobot";
import {
  ALL_PROJECTS,
  assistantProjectFields,
  assistantProjectSelection,
  sameProjects,
} from "@t3tools/client-runtime/assistantSections";
import { sameAssistantAutonomy } from "@t3tools/client-runtime/autonomy";
import {
  ASSISTANT_AVATAR_MAX_BYTES,
  ASSISTANT_AVATAR_MIME_TYPES,
  assistantHandleFromName,
  AssistantHandle,
  DEFAULT_ASSISTANT_AUTONOMY,
  type Assistant,
  type AssistantId,
  type AssistantAutonomy,
  type AssistantsCreateInput,
  type AssistantsUpdateInput,
  type AssistantTeam,
  type AssistantTeamId,
  type AssistantTeamsUpdateInput,
  type AssistantToolAccess,
  type AssistantWorkspace,
  type BudgetPeriod,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderBudget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";

export type AvatarImageDraft =
  | { readonly kind: "stored" }
  | { readonly kind: "file"; readonly file: DraftComposerImageAttachment }
  | null;

/** Where "new assistant here" starts: a project or a group's "+". */
export interface AssistantPreset {
  readonly projectId?: ProjectId;
  readonly teamId?: AssistantTeamId;
  /** How many assistants exist: the new one's default look follows it. */
  readonly lookIndex?: number;
}

export interface AssistantDraft {
  readonly name: string;
  /** Null while it still follows the name. */
  readonly handle: string | null;
  /** Null until chosen; the form then shows "All projects". Holds `ALL_PROJECTS` or project ids. */
  readonly projectIds: ReadonlyArray<string> | null;
  /** Null until picked; the form then shows the conversation's current or default model. */
  readonly modelSelection: ModelSelection | null;
  readonly instructions: string;
  readonly toolAccess: AssistantToolAccess;
  readonly askBeforeActing: boolean;
  readonly workspace: AssistantWorkspace;
  readonly avatar: { readonly hue: number; readonly variant: number };
  /** The stored picture kept as is, a picked one waiting for Save, or none (the robot). */
  readonly avatarImage: AvatarImageDraft;
  readonly avatarTouched: boolean;
  /** Groups the user ticked or unticked; absent means the assistant's current membership. */
  readonly groupChoices: Readonly<Record<string, boolean>>;
  readonly connectors: ReadonlyArray<ConnectorDraft>;
  readonly role: string;
  readonly budget: BudgetDraft;
  readonly autonomy: AssistantAutonomy;
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
  readonly preset?: AssistantPreset;
  readonly initial: AssistantDraft;
  readonly current: AssistantDraft;
}

/** The form draft lives in an atom, so it survives while the model picker route is on top. */
export const assistantEditorAtom = Atom.make<AssistantEditor | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:editor"),
);

export function assistantDraftFor(
  assistant: Assistant | null,
  preset: AssistantPreset = {},
): AssistantDraft {
  const look = assistantRobotLook(
    assistant ?? {
      id: "new",
      avatar: { kind: "robot", ...newAssistantLook(preset.lookIndex ?? 0) },
    },
  );
  return {
    name: assistant?.name ?? "",
    handle: assistant?.handle ?? null,
    projectIds: assistant
      ? assistantProjectSelection(assistant)
      : preset.projectId
        ? [preset.projectId]
        : null,
    modelSelection: null,
    instructions: assistant?.instructions ?? "",
    toolAccess: assistant?.toolAccess ?? "workspace-write",
    askBeforeActing: assistant?.askBeforeActing ?? true,
    workspace: assistant?.workspace ?? "host",
    avatar: look,
    avatarImage: assistant?.avatar?.kind === "image" ? { kind: "stored" } : null,
    avatarTouched: false,
    groupChoices:
      assistant === null && preset.teamId !== undefined ? { [preset.teamId]: true } : {},
    connectors: connectorDraftsFrom(assistant?.mcpServers ?? []),
    role: assistant?.role ?? "",
    budget: budgetDraftFor(assistant?.budget),
    autonomy: assistant?.autonomy ?? DEFAULT_ASSISTANT_AUTONOMY,
  };
}

export function startAssistantEditor(
  environmentId: EnvironmentId,
  assistant: Assistant | null,
  preset?: AssistantPreset,
) {
  const draft = assistantDraftFor(assistant, preset);
  appAtomRegistry.set(assistantEditorAtom, {
    environmentId,
    assistant,
    ...(preset === undefined ? {} : { preset }),
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

/** Why a picked image cannot be an avatar, or null. The server checks the bytes again. */
export function avatarImageProblem(image: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): string | null {
  if (
    !(ASSISTANT_AVATAR_MIME_TYPES as ReadonlyArray<string>).includes(image.mimeType.toLowerCase())
  ) {
    return "Use a PNG, JPEG or WebP image.";
  }
  if (image.sizeBytes > ASSISTANT_AVATAR_MAX_BYTES) {
    return `The image must be under ${ASSISTANT_AVATAR_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

const robotAvatarOf = (draft: AssistantDraft) =>
  ({ kind: "robot", hue: draft.avatar.hue, variant: draft.avatar.variant }) as const;

/** Whether the assistant is in this group as the form stands. */
export function assistantInGroup(editor: AssistantEditor, team: AssistantTeam): boolean {
  return (
    editor.current.groupChoices[team.id] ??
    (editor.assistant !== null && team.memberIds.includes(editor.assistant.id))
  );
}

/** Ticks or unticks a group; a choice that matches where the form started is forgotten. */
export function setAssistantGroup(team: AssistantTeam, selected: boolean) {
  const editor = appAtomRegistry.get(assistantEditorAtom);
  if (!editor) return;
  const member = editor.assistant !== null && team.memberIds.includes(editor.assistant.id);
  const { [team.id]: _dropped, ...rest } = editor.current.groupChoices;
  const groupChoices =
    editor.initial.groupChoices[team.id] === undefined && selected === member
      ? rest
      : { ...rest, [team.id]: selected };
  updateAssistantDraft({ groupChoices });
}

/**
 * One team update per group the assistant joined or left. A lead must be a member, so leaving a
 * group as its lead clears it.
 */
export function teamMembershipUpdates(
  teams: ReadonlyArray<AssistantTeam>,
  assistantId: AssistantId,
  inGroup: (team: AssistantTeam) => boolean,
): ReadonlyArray<AssistantTeamsUpdateInput> {
  return teams.flatMap((team) => {
    const wasMember = team.memberIds.includes(assistantId);
    if (inGroup(team) === wasMember) return [];
    return [
      {
        teamId: team.id,
        memberIds: wasMember
          ? team.memberIds.filter((id) => id !== assistantId)
          : [...team.memberIds, assistantId],
        ...(wasMember && team.leadId === assistantId ? { leadId: null } : {}),
      },
    ];
  });
}

export function assistantDraftHasChanges(editor: AssistantEditor): boolean {
  const {
    budget: initialBudget,
    autonomy: initialAutonomy,
    avatarImage: initialImage,
    ...initial
  } = editor.initial;
  const {
    budget: currentBudget,
    autonomy: currentAutonomy,
    avatarImage: currentImage,
    ...current
  } = editor.current;
  // A picked image carries megabytes of data; it is compared by identity, never serialized.
  const imageKey = (image: AvatarImageDraft) =>
    image === null ? "none" : image.kind === "stored" ? "stored" : image.file.id;
  return (
    imageKey(initialImage) !== imageKey(currentImage) ||
    JSON.stringify(initial) !== JSON.stringify(current) ||
    budgetDraftChanged(initialBudget, currentBudget) ||
    !sameAssistantAutonomy(initialAutonomy, currentAutonomy)
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
  picked: ReadonlyArray<string>,
): boolean {
  if (assistant === null) return false;
  if (picked.includes(ALL_PROJECTS)) return assistant.scope !== "all";
  return effectiveProjectId !== null && effectiveProjectId !== assistant.projectId;
}

export function assistantCreateInput(
  editor: AssistantEditor,
  picked: ReadonlyArray<string>,
  home = picked[0] as ProjectId,
): AssistantsCreateInput {
  const { current } = editor;
  return {
    name: current.name.trim(),
    handle: effectiveAssistantHandle(current),
    ...assistantProjectFields(picked as ReadonlyArray<ProjectId>, home),
    ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
    instructions: current.instructions,
    toolAccess: current.toolAccess,
    ...(current.askBeforeActing ? { askBeforeActing: true } : {}),
    ...(current.workspace === "host" ? {} : { workspace: current.workspace }),
    ...(current.avatarImage?.kind === "file" ? {} : { avatar: robotAvatarOf(current) }),
    ...(current.connectors.length === 0
      ? {}
      : { mcpServers: connectorInputsFrom(current.connectors) }),
    ...(current.role.trim() === "" ? {} : { role: current.role.trim() }),
    ...(current.budget.enabled ? { budget: budgetFromDraft(current.budget) } : {}),
    ...(sameAssistantAutonomy(current.autonomy, DEFAULT_ASSISTANT_AUTONOMY)
      ? {}
      : { autonomy: current.autonomy }),
  };
}

/** Only what the user changed is sent, so an untouched field never overwrites a newer edit. */
export function assistantUpdateInput(
  editor: AssistantEditor & { readonly assistant: Assistant },
  picked: ReadonlyArray<string>,
  home = picked[0] as ProjectId,
): AssistantsUpdateInput {
  const { assistant, current } = editor;
  const name = current.name.trim();
  const handle = effectiveAssistantHandle(current);
  return {
    assistantId: assistant.id,
    ...(name !== assistant.name ? { name } : {}),
    ...(handle !== assistant.handle ? { handle } : {}),
    ...(sameProjects(picked, assistantProjectSelection(assistant))
      ? {}
      : assistantProjectFields(picked as ReadonlyArray<ProjectId>, home)),
    ...(current.modelSelection ? { modelSelection: current.modelSelection } : {}),
    ...(current.instructions !== assistant.instructions
      ? { instructions: current.instructions }
      : {}),
    ...(current.toolAccess !== assistant.toolAccess ? { toolAccess: current.toolAccess } : {}),
    ...(current.askBeforeActing !== assistant.askBeforeActing
      ? { askBeforeActing: current.askBeforeActing }
      : {}),
    ...(current.workspace !== assistant.workspace ? { workspace: current.workspace } : {}),
    ...(current.avatarTouched && current.avatarImage?.kind !== "file"
      ? { avatar: robotAvatarOf(current) }
      : {}),
    ...(connectorsEqual(editor.initial.connectors, current.connectors)
      ? {}
      : { mcpServers: connectorInputsFrom(current.connectors) }),
    ...(current.role.trim() !== assistant.role ? { role: current.role.trim() } : {}),
    ...(budgetDraftChanged(editor.initial.budget, current.budget)
      ? { budget: budgetFromDraft(current.budget) }
      : {}),
    ...(sameAssistantAutonomy(current.autonomy, assistant.autonomy)
      ? {}
      : { autonomy: current.autonomy }),
  };
}

/** A new assistant's server is the only part the form can change before it is saved. */
export function changeAssistantEditorEnvironment(environmentId: EnvironmentId) {
  const editor = appAtomRegistry.get(assistantEditorAtom);
  if (editor && editor.assistant === null && editor.environmentId !== environmentId) {
    appAtomRegistry.set(assistantEditorAtom, {
      ...editor,
      environmentId,
      current: { ...editor.current, projectIds: null, modelSelection: null },
    });
  }
}
