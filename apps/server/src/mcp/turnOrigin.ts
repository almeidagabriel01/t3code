import {
  OrchestratorMcpFailure,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AssistantGroups } from "../assistants/AssistantGroups.ts";
import { WAKE_MESSAGE_PREFIX } from "../autonomy/autonomyRules.ts";
import type { Caller } from "./threadAccess.ts";

export type TurnOrigin = "user" | "assistant" | "routine" | "group" | "other";

const ORIGIN_LABELS: Record<Exclude<TurnOrigin, "user">, string> = {
  assistant: "another assistant or agent",
  routine: "a scheduled task",
  group: "a group task",
  other: "an automatic message",
};

/** Read from the message that started the turn, never from anything the model supplies. */
export const turnOriginOf = (
  message:
    | Pick<
        OrchestrationV2ConversationMessage,
        "id" | "createdBy" | "scheduledTaskId" | "senderThreadId" | "notification"
      >
    | undefined,
): TurnOrigin => {
  if (message === undefined) return "other";
  if (message.id.startsWith("group-task:")) return "group";
  if (message.scheduledTaskId !== undefined) return "routine";
  if (message.senderThreadId !== undefined || message.id.startsWith("assistant-reply:"))
    return "assistant";
  if (
    message.createdBy === "user" &&
    message.notification === undefined &&
    !message.id.startsWith(WAKE_MESSAGE_PREFIX)
  )
    return "user";
  return "other";
};

const startingMessage = Effect.fn("mcp.startingMessage")(function* (caller: Caller) {
  const shell = caller.caller;
  if (shell === undefined) return undefined;
  const runId = shell.activeRunId ?? shell.latestRunId;
  const records =
    runId === null
      ? undefined
      : yield* caller.threads
          .getThreadRecords(shell.id, ["runs", "messages"], {
            runIds: [runId],
            messageRoles: ["user"],
          })
          .pipe(Effect.orElseSucceed(() => undefined));
  const userMessageId = records?.runs.find((run) => run.id === runId)?.userMessageId;
  return { message: records?.messages.find((message) => message.id === userMessageId) };
});

const denied = (what: string, origin: Exclude<TurnOrigin, "user">) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `Only the user can ${what}; this turn came from ${ORIGIN_LABELS[origin]}. Ask the user. Do not retry.`,
  });

/** A client credential has no turn: the user who issued it is the caller. */
export const requireUserTurn = Effect.fn("mcp.requireUserTurn")(function* (
  caller: Caller,
  what: string,
) {
  const start = yield* startingMessage(caller);
  if (start === undefined) return;
  const origin = turnOriginOf(start.message);
  if (origin === "user") return;
  return yield* denied(what, origin);
});

/**
 * Like `requireUserTurn`, and a member's group task counts too when the request it came from
 * (however many hand-offs ago) was written by the user in the group's chat.
 */
export const requireUserAskedInGroup = Effect.fn("mcp.requireUserAskedInGroup")(function* (
  caller: Caller,
  what: string,
) {
  const start = yield* startingMessage(caller);
  if (start === undefined) return;
  const origin = turnOriginOf(start.message);
  if (origin === "user") return;
  if (origin === "group") {
    const groups = yield* AssistantGroups;
    const scope = yield* groups.member
      .routineScope({ callerThreadId: caller.caller!.id })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (scope?.askedByUser === true) return;
  }
  return yield* denied(what, origin);
});
