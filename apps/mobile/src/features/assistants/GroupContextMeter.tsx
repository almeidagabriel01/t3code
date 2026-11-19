import { assistantGroupComposerSession } from "@t3tools/client-runtime/assistantGroupChat";
import { deriveLatestContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useEffect, useRef } from "react";
import type {
  Assistant,
  EnvironmentId,
  OrchestrationV2ThreadContextUsage,
  ThreadId,
} from "@t3tools/contracts";

import {
  type AssistantGroupChatRef,
  useAssistantGroupChat,
  useAssistantGroupSendContext,
} from "../../state/assistants";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { ComposerContextMeter } from "../threads/ComposerContextMeter";

/**
 * The context of the member a reply lands with, in that request's thread. Nothing for a new
 * request, which opens fresh threads, nor while the session or the server cannot say.
 */
export function GroupContextMeter(props: {
  readonly environmentId: EnvironmentId;
  readonly chat: AssistantGroupChatRef;
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly leadId: Assistant["id"] | null;
}) {
  const { environmentId, chat } = props;
  const state = useAssistantGroupChat(environmentId, chat.teamId, chat.scope);
  const context = useAssistantGroupSendContext(environmentId, chat);
  const requestId =
    chat.reply === null ? null : (state?.messages.get(chat.reply.id)?.requestId ?? null);
  const task = assistantGroupComposerSession({
    state,
    requestId,
    text: props.text,
    members: props.members,
    leadId: props.leadId,
    context,
  });
  if (task === null) return null;
  const name = props.members.find((member) => member.id === task.ownerId)?.name ?? "Removed member";
  return (
    <SessionContextMeter
      key={task.threadId}
      environmentId={environmentId}
      threadId={task.threadId}
      updatedAt={task.updatedAt}
      title={`Context of ${name} in this request`}
    />
  );
}

function SessionContextMeter(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The task's last change: its thread may have used more context since the last read. */
  readonly updatedAt: string;
  readonly title: string;
}) {
  const query = useEnvironmentQuery<OrchestrationV2ThreadContextUsage | null, unknown>(
    orchestrationEnvironment.threadContextUsage({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const { refresh } = query;
  const readAt = useRef(props.updatedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the meter is a one-off server read; a task update asks the server again
  useEffect(() => {
    if (readAt.current === props.updatedAt) return;
    readAt.current = props.updatedAt;
    refresh();
  }, [props.updatedAt, refresh]);
  const usage =
    query.data == null
      ? null
      : deriveLatestContextWindowSnapshot(
          [],
          query.data.latestTurnUsage,
          query.data.providerThread,
        );
  return usage === null ? null : <ComposerContextMeter usage={usage} title={props.title} />;
}
