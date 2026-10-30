import { DecisionId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const DecisionParameters = Schema.Struct({
  action: Schema.Literals(["request", "list", "read", "withdraw"]),
  title: Schema.optional(Schema.String),
  context: Schema.optional(Schema.String),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        label: Schema.String,
        consequence: Schema.optional(Schema.String),
      }),
    ),
  ),
  recommended: Schema.optional(Schema.String),
  expiresInMinutes: Schema.optional(Schema.Int),
  clientRequestId: Schema.optional(Schema.String),
  decisionId: Schema.optional(DecisionId),
  all: Schema.optional(Schema.Boolean),
});
export type DecisionParameters = typeof DecisionParameters.Type;

const DecisionTool = Tool.make("t3_decision", {
  description:
    "Ask the user a decision that outlives this turn. `request` (title, options [{label, consequence?}], context markdown, recommended = an option label, expiresInMinutes, clientRequestId stable per question) returns {decisionId, status} at once and never waits. The answer arrives later as a message in this thread: end the turn or do other work, and never assume approval, including after expiry or a dismissal. Use it when nobody is live here (background, scheduled or delegated runs) or the choice is costly to undo; a user who is here gets a chat question. `list` (`all` = every thread), `read` and `withdraw` (decisionId).",
  parameters: DecisionParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    DecisionService.DecisionService,
  ],
}).annotate(Tool.Destructive, false);

export const DecisionToolkit = Toolkit.make(DecisionTool);
