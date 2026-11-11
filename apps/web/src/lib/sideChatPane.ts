import type { OrchestrationV2ThreadShell, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

import type { ToolCallDiffTarget } from "../diffPanelStore";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { useRightPanelStore } from "../rightPanelStore";

/** Whether an event started in the side chat pane (`data-side-chat-pane`), which the main chat ignores. */
export function isInSideChatPane(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-side-chat-pane]") !== null;
}

/**
 * Opens an embedded side chat's tool diffs in its parent's diff panel and runs its shell commands
 * in the parent's terminal drawer, since the embedded view hides its own. Other panel actions reach
 * the parent through `hostRightPanel`; diff selection and the drawer are not panel state.
 */
export interface SideChatParentPanel {
  readonly openToolDiff: (target: ToolCallDiffTarget) => void;
  readonly runShellCommand: (command: string) => void;
  readonly sendToComposer: (text: string) => void;
}

/** Adds `text` after what the user already typed, separated by a blank line. */
export function appendToDraftPrompt(prompt: string, text: string): string {
  return prompt.trim().length === 0 ? text : `${prompt.replace(/\s+$/, "")}\n\n${text}`;
}

/** Opens `thread` in its tab when it is a side chat of `parentRef`; false for any other thread. */
export function openSideChatTab(
  parentRef: ScopedThreadRef,
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage"> | null,
): boolean {
  if (thread?.lineage.sideChat !== true || thread.lineage.parentThreadId !== parentRef.threadId) {
    return false;
  }
  useRightPanelStore.getState().openSideChat(parentRef, thread.id);
  return true;
}

/** Appends `text` to the composer draft of `target`, keeping what the user already typed. */
export function appendToComposerDraft(target: ComposerThreadTarget, text: string): void {
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, appendToDraftPrompt(store.getComposerDraft(target)?.prompt ?? "", text));
}

/** Messages of side chats whose tab is open while the server still creates them, by thread id. */
export const useStartingSideChats = create<Readonly<Record<string, string>>>(() => ({}));

/** Shows `prompt` in the side chat's tab until it starts; null once it started or failed. */
export function setStartingSideChat(threadId: ThreadId, prompt: string | null): void {
  useStartingSideChats.setState((current) => {
    const { [threadId]: _dropped, ...rest } = current;
    return prompt === null ? rest : { ...rest, [threadId]: prompt };
  }, true);
}
