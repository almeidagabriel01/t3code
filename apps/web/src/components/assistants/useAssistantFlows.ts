import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANTS_RESTORE_DEFAULT_INPUT,
  type Assistant,
  type AssistantTeam,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { requestConfirmDialog } from "../../confirmDialog";
import {
  useAssistantActions,
  useAssistantGroupActions,
  setAssistantTaskDismissed,
  useAssistantTeamActions,
  type AssistantReply,
} from "../../state/assistants";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

/** Dismisses or restores a task from any environment, toasting a refusal. */
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

  const openThread = (threadRef: ScopedThreadRef) => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  return {
    canAct: actions.canAct,
    openConversation,
    openThread,
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
    dismissTask: (threadId: ThreadId) => setTaskDismissed(environmentId, threadId, true),
    restoreTask: (threadId: ThreadId) => setTaskDismissed(environmentId, threadId, false),
    async restoreDefault() {
      failed("Could not restore Jarvis", await actions.create(ASSISTANTS_RESTORE_DEFAULT_INPUT));
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

/** The confirmed group actions, shared by the sidebar, the chat header and the pages. */
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
    markRead: (team: Pick<AssistantTeam, "id" | "chat">) =>
      mark(team.id, { readSeq: team.chat?.latestSeq ?? 0 }),
    markUnread: (team: Pick<AssistantTeam, "id">) => mark(team.id, { unread: true }),
    async archive(team: Pick<AssistantTeam, "id" | "name">) {
      const confirmed = await requestConfirmDialog(
        `Archive ${team.name}?\nIts chat is kept, but its work stops and it takes no new messages. You can restore it.`,
      );
      if (confirmed === false) return;
      failed(
        "Could not archive the group",
        await actions.update({ teamId: team.id, archived: true }),
      );
    },
    async restore(team: Pick<AssistantTeam, "id">) {
      failed(
        "Could not restore the group",
        await actions.update({ teamId: team.id, archived: false }),
      );
    },
  };
}
