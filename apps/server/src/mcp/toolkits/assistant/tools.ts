import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantService from "../../../assistants/AssistantService.ts";

export const AssistantParameters = Schema.Struct({
  action: Schema.Literals(["list", "read"]),
  handle: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type AssistantParameters = typeof AssistantParameters.Type;

const AssistantTool = Tool.make("t3_assistant", {
  description:
    "The user's named assistants (Jarvis, others): each a long-lived thread. `list`, or `read` a `handle`: {handle, name, threadId, toolAccess, archived}. To ask one something, t3_thread_send to its threadId, then t3_thread_wait. You cannot create or configure assistants.",
  parameters: AssistantParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [AssistantService.AssistantService],
})
  .annotate(Tool.Title, "Assistants")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AssistantToolkit = Toolkit.make(AssistantTool);
