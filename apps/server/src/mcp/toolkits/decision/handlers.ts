import {
  DecisionId,
  OrchestratorMcpFailure,
  type Decision,
  type DecisionError,
  type DecisionOption,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";

import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { type DecisionParameters, DecisionToolkit } from "./tools.ts";

type Out = Record<string, Schema.Json>;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const decisionFailure = (error: DecisionError) =>
  error.reason === "storage" ? unavailable() : invalid(error.message);

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined || (typeof value === "string" && value.trim() === "")
    ? Effect.fail(invalid(`${action} needs \`${name}\`.`))
    : Effect.succeed(value);

const brief = (decision: Decision, withContext: boolean): Out => ({
  decisionId: decision.id,
  title: decision.title,
  status: decision.status,
  ...(withContext
    ? {
        context: decision.context,
        options: decision.options.map(({ id, label, consequence }) => ({
          id,
          label,
          ...(consequence === undefined ? {} : { consequence }),
        })),
      }
    : {}),
  ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
  ...(decision.answer === undefined
    ? {}
    : {
        answer: {
          ...(decision.answer.optionId === undefined ? {} : { optionId: decision.answer.optionId }),
          ...(decision.answer.text === undefined ? {} : { text: decision.answer.text }),
        },
      }),
  ...(decision.deliveredAt === undefined ? {} : { delivered: true }),
});

/** Options get positional ids unless the agent named them; `recommended` may be an id or a label. */
const withIds = (options: NonNullable<DecisionParameters["options"]>): DecisionOption[] =>
  options.map((option, index) => ({
    id: option.id?.trim() || `o${index + 1}`,
    label: option.label,
    ...(option.consequence === undefined ? {} : { consequence: option.consequence }),
  }));

const run = Effect.fn("mcp.decision.run")(
  function* (input: DecisionParameters) {
    const decisions = yield* DecisionService.DecisionService;
    const context = yield* loadCaller();
    const threadId = context.scope.thread!.threadId;
    switch (input.action) {
      case "request": {
        const title = yield* need(input.title, "title", "request");
        const options = withIds(yield* need(input.options, "options", "request"));
        const wanted = input.recommended?.trim().toLowerCase();
        const recommended =
          wanted === undefined
            ? undefined
            : options.find(
                (option) =>
                  option.id.toLowerCase() === wanted ||
                  option.label.trim().toLowerCase() === wanted,
              )?.id;
        if (wanted !== undefined && recommended === undefined) {
          return yield* invalid("recommended must be one of the options.");
        }
        const decision = yield* decisions.request({
          fromThreadId: threadId,
          projectId: context.caller!.projectId,
          threadTitle: context.caller!.title,
          // A repeat of the same question lands on the same decision when no id was sent.
          clientRequestId:
            input.clientRequestId?.trim() ||
            `auto:${title}|${options.map((option) => option.label).join("|")}`.slice(0, 512),
          title,
          context: input.context ?? "",
          options,
          recommended,
          expiresInMinutes: input.expiresInMinutes,
        });
        return {
          decisionId: decision.id,
          status: decision.status,
          ...(decision.expiresAt === undefined ? {} : { expiresAt: decision.expiresAt }),
        } satisfies Out;
      }
      case "list": {
        const list = yield* decisions.list(input.all === true ? {} : { threadId });
        return { decisions: list.map((decision) => brief(decision, false)) } satisfies Out;
      }
      case "read":
        return brief(
          yield* decisions.get(
            DecisionId.make(yield* need(input.decisionId, "decisionId", "read")),
          ),
          true,
        );
      case "withdraw": {
        const decision = yield* decisions.withdraw({
          decisionId: yield* need(input.decisionId, "decisionId", "withdraw"),
          fromThreadId: threadId,
        });
        return { decisionId: decision.id, status: decision.status } satisfies Out;
      }
    }
  },
  Effect.catchTags({ DecisionError: (error) => Effect.fail(decisionFailure(error)) }),
);

export const layer = McpToolAccess.toLayer(DecisionToolkit, {
  t3_decision: McpToolAccess.either(
    (input: DecisionParameters) => input.action === "list" || input.action === "read",
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
