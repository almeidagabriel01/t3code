import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { requestConfirmDialog } from "../../confirmDialog";
import { useAssistantActions, type AssistantReply } from "../../state/assistants";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

function failed(title: string, reply: AssistantReply<unknown>) {
  if (reply.ok) return;
  toastManager.add({ type: "error", title, description: reply.message });
}

/** The confirmed assistant actions, shared by the sidebar, the thread menu and Settings. */
export function useAssistantFlows(environmentId: EnvironmentId) {
  const actions = useAssistantActions(environmentId);
  const router = useRouter();

  const openConversation = (assistant: Assistant) => {
    if (assistant.threadId === null) return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, assistant.threadId)),
    });
  };

  return {
    canAct: actions.canAct,
    openConversation,
    async reset(assistant: Assistant, options: { readonly openAfter?: boolean } = {}) {
      const confirmed = await requestConfirmDialog(
        `Start a new conversation with ${assistant.name}?\nThe current one moves to Archive, where you can restore it.`,
      );
      if (confirmed === false) return;
      const reply = await actions.reset({ assistantId: assistant.id });
      if (!reply.ok) return failed("Could not reset the conversation", reply);
      if (options.openAfter) openConversation(reply.value);
    },
    async archive(assistant: Assistant) {
      const confirmed = await requestConfirmDialog(
        `Archive ${assistant.name}?\nIt leaves the sidebar. Its conversation and settings are kept, and you can unarchive it.`,
      );
      if (confirmed === false) return;
      failed(
        "Could not archive the assistant",
        await actions.update({ assistantId: assistant.id, archived: true }),
      );
    },
    async unarchive(assistant: Assistant) {
      failed(
        "Could not unarchive the assistant",
        await actions.update({ assistantId: assistant.id, archived: false }),
      );
    },
    async remove(assistant: Assistant) {
      const confirmed = await requestConfirmDialog(
        `Delete ${assistant.name}?\nThis permanently deletes the assistant and every conversation it had.`,
        { variant: "destructive" },
      );
      if (confirmed === false) return;
      failed("Could not delete the assistant", await actions.remove(assistant.id));
    },
  };
}
