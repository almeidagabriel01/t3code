import type { AutonomyWatchDraft } from "@t3tools/client-runtime/autonomy";
import type { AssistantId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface AssistantWatchEditor {
  readonly environmentId: EnvironmentId;
  readonly assistantId: AssistantId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly label: string }>;
  readonly initial: AutonomyWatchDraft;
  readonly current: AutonomyWatchDraft;
}

/** The open watch form lives in an atom, so it is one value the route reads and the list starts. */
export const assistantWatchEditorAtom = Atom.make<AssistantWatchEditor | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("assistants:watch-editor"),
);

export function startAssistantWatchEditor(
  editor: Omit<AssistantWatchEditor, "initial" | "current"> & {
    readonly draft: AutonomyWatchDraft;
  },
) {
  const { draft, ...rest } = editor;
  appAtomRegistry.set(assistantWatchEditorAtom, { ...rest, initial: draft, current: draft });
}

export function updateAssistantWatchDraft(change: Partial<AutonomyWatchDraft>) {
  const editor = appAtomRegistry.get(assistantWatchEditorAtom);
  if (editor) {
    appAtomRegistry.set(assistantWatchEditorAtom, {
      ...editor,
      current: { ...editor.current, ...change },
    });
  }
}

export function discardAssistantWatchEditor() {
  appAtomRegistry.set(assistantWatchEditorAtom, null);
}

export function assistantWatchDraftHasChanges(editor: AssistantWatchEditor): boolean {
  return JSON.stringify(editor.initial) !== JSON.stringify(editor.current);
}
