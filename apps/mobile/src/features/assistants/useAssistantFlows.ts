import {
  ASSISTANTS_RESTORE_DEFAULT_INPUT,
  type Assistant,
  type AssistantGroupConversationAction,
  type AssistantTeam,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import {
  useAssistantActions,
  useAssistantGroupActions,
  setAssistantTaskDismissed,
  useAssistantTeamActions,
  type AssistantReply,
} from "../../state/assistants";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

/** Dismisses or restores a task from any environment, alerting on a refusal. */
export async function setTaskDismissed(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  dismissed: boolean,
) {
  failed(
    dismissed ? "Could not dismiss the task" : "Could not restore the task",
    await setAssistantTaskDismissed(environmentId, threadId, dismissed),
  );
}

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
    dismissTask: (threadId: ThreadId) => setTaskDismissed(environmentId, threadId, true),
    restoreTask: (threadId: ThreadId) => setTaskDismissed(environmentId, threadId, false),
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
  const reading = useAssistantGroupActions(environmentId);
  const mark = async (
    teamId: AssistantTeam["id"],
    position: Parameters<typeof reading.markRead>[1],
  ) => failed("Could not update the group", await reading.markRead(teamId, position));
  return {
    canAct: actions.canAct,
    canMarkRead: reading.canMarkRead,
    canConverse: reading.canConverse,
    /** New conversation or compact; the chat follows through its own stream. */
    converse: async (team: Pick<AssistantTeam, "id">, action: AssistantGroupConversationAction) =>
      failed("Could not change the conversation", await reading.conversation(team.id, action)),
    clear(team: Pick<AssistantTeam, "id" | "name">, onCleared: () => void) {
      Dialog.confirm({
        title: `Clear the history of ${team.name}?`,
        message:
          "Every message, task and file in this chat is deleted. Members keep their own conversations. This cannot be undone.",
        confirmText: "Clear history",
        destructive: true,
        onConfirm: () => {
          void (async () => {
            const reply = await reading.conversation(team.id, "clear");
            failed("Could not clear the history", reply);
            if (reply.ok) onCleared();
          })();
        },
      });
    },
    markRead: (team: Pick<AssistantTeam, "id" | "chat">) =>
      mark(team.id, { readSeq: team.chat?.latestSeq ?? 0 }),
    markUnread: (team: Pick<AssistantTeam, "id">) => mark(team.id, { unread: true }),
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
