import {
  ASSISTANTS_RESTORE_DEFAULT_INPUT,
  type Assistant,
  type AssistantTeam,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import {
  useAssistantActions,
  useAssistantTeamActions,
  type AssistantReply,
} from "../../state/assistants";
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
    async restoreDefault() {
      failed("Could not restore Jarvis", await actions.create(ASSISTANTS_RESTORE_DEFAULT_INPUT));
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

/** Archive and restore of a group, shared by Home, Settings and the chat's menu. */
export function useAssistantTeamFlows(environmentId: EnvironmentId) {
  const actions = useAssistantTeamActions(environmentId);
  return {
    canAct: actions.canAct,
    archive(team: Pick<AssistantTeam, "id" | "name">) {
      Dialog.confirm({
        title: `Archive ${team.name}?`,
        message:
          "Its chat is kept, but its work stops and it takes no new messages. You can restore it.",
        confirmText: "Archive",
        onConfirm: () => {
          void (async () =>
            failed(
              "Could not archive the group",
              await actions.update({ teamId: team.id, archived: true }),
            ))();
        },
      });
    },
    async restore(team: Pick<AssistantTeam, "id">) {
      failed(
        "Could not restore the group",
        await actions.update({ teamId: team.id, archived: false }),
      );
    },
  };
}
