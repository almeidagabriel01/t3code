import type { Assistant, EnvironmentId, ThreadId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useAssistantActions, type AssistantReply } from "../../state/assistants";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

function failed(title: string, reply: AssistantReply<unknown>) {
  if (!reply.ok) Dialog.alert(title, reply.message);
}

/** The confirmed assistant actions, shared by Home, the thread menu and Settings. */
export function useAssistantFlows(environmentId: EnvironmentId) {
  const actions = useAssistantActions(environmentId);
  const selectDetail = useSelectWorkspaceDetail();

  const openConversation = (assistant: Pick<Assistant, "threadId">) => {
    if (assistant.threadId === null) return;
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(assistant.threadId) },
    });
  };

  return {
    canAct: actions.canAct,
    openConversation,
    reset(assistant: Assistant, options: { readonly openAfter?: boolean } = {}) {
      Dialog.confirm({
        title: `Start a new conversation with ${assistant.name}?`,
        message: "The current one moves to Archive, where you can restore it.",
        confirmText: "Start new conversation",
        onConfirm: () => {
          void (async () => {
            const reply = await actions.reset({ assistantId: assistant.id });
            if (!reply.ok) return failed("Could not reset the conversation", reply);
            if (options.openAfter) openConversation(reply.value);
          })();
        },
      });
    },
    archive(assistant: Assistant) {
      Dialog.confirm({
        title: `Archive ${assistant.name}?`,
        message:
          "It leaves Home. Its conversation and settings are kept, and you can unarchive it.",
        confirmText: "Archive",
        onConfirm: () => {
          void (async () =>
            failed(
              "Could not archive the assistant",
              await actions.update({ assistantId: assistant.id, archived: true }),
            ))();
        },
      });
    },
    async unarchive(assistant: Assistant) {
      failed(
        "Could not unarchive the assistant",
        await actions.update({ assistantId: assistant.id, archived: false }),
      );
    },
    remove(assistant: Assistant, onRemoved?: () => void) {
      Dialog.confirm({
        title: `Delete ${assistant.name}?`,
        message: "This permanently deletes the assistant and every conversation it had.",
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void (async () => {
            const reply = await actions.remove(assistant.id);
            if (reply.ok) onRemoved?.();
            else failed("Could not delete the assistant", reply);
          })();
        },
      });
    },
    async restore(assistant: Assistant, threadId: ThreadId) {
      const reply = await actions.reset({ assistantId: assistant.id, restoreThreadId: threadId });
      failed("Could not restore the conversation", reply);
      return reply.ok;
    },
  };
}
