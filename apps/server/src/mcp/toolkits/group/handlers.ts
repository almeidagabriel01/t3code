import { type AssistantError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { type GroupParameters, GroupToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const failure = (error: AssistantError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const need = (value: string | undefined, message: string) =>
  value === undefined || value.trim() === ""
    ? Effect.fail(invalid(message))
    : Effect.succeed(value.trim());

const run = Effect.fn("mcp.group.run")(function* (input: GroupParameters) {
  const groups = yield* AssistantGroups.AssistantGroups;
  const { caller } = yield* loadCaller();
  if (caller === undefined) return yield* invalid("This tool only works inside a group task.");
  const callerThreadId = caller.id;
  switch (input.action) {
    case "history": {
      const page = yield* groups.member
        .history({
          callerThreadId,
          ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        })
        .pipe(Effect.mapError(failure));
      return {
        messages: page.messages.map((message) => ({
          seq: message.seq,
          author: message.author,
          assistantId: message.assistantId,
          label: message.authorLabel,
          kind: message.kind,
          text: message.text,
        })),
        hasMore: page.hasMore,
      } satisfies Out;
    }
    case "assign": {
      const member = yield* need(input.member, "assign needs `member`.");
      const instruction = yield* need(input.text, "assign needs `text`: the subtask.");
      return yield* groups.member
        .assign({
          callerThreadId,
          member,
          instruction,
          ...(input.expectedResult === undefined ? {} : { expectedResult: input.expectedResult }),
          ...(input.sourceSeqs === undefined ? {} : { sourceSeqs: input.sourceSeqs }),
          ...(input.resources === undefined ? {} : { resources: input.resources }),
        })
        .pipe(Effect.mapError(failure));
    }
    case "transfer": {
      const member = yield* need(input.member, "transfer needs `member`.");
      return yield* groups.member
        .transfer({ callerThreadId, member, note: input.text?.trim() ?? "" })
        .pipe(Effect.mapError(failure));
    }
    case "reply": {
      if (input.seq === undefined)
        return yield* invalid("reply needs `seq`: the #number of the member message.");
      const text = yield* need(input.text, "reply needs `text`: your question.");
      return {
        ...(yield* groups.member
          .reply({ callerThreadId, seq: input.seq, text })
          .pipe(Effect.mapError(failure))),
      };
    }
    case "cancel": {
      const taskId = yield* need(input.taskId, "cancel needs `taskId`: the subtask's id.");
      return {
        ...(yield* groups.member
          .cancel({ callerThreadId, taskId, reason: input.text?.trim() ?? "" })
          .pipe(Effect.mapError(failure))),
      };
    }
    case "result": {
      const text = yield* need(input.text, "result needs `text`: your answer.");
      return {
        ...(yield* groups.member.result({ callerThreadId, text }).pipe(Effect.mapError(failure))),
      };
    }
  }
});

export const layer = McpToolAccess.toLayer(GroupToolkit, {
  t3_group: McpToolAccess.either(
    (input: GroupParameters) => input.action === "history",
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
