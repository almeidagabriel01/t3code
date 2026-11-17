import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import * as IntegrationAuth from "../../../integrations/IntegrationAuth.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const IntegrationParameters = Schema.Struct({
  action: Schema.Literals(["list", "read"]),
  /** read: the integration's id from list. */
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type IntegrationParameters = typeof IntegrationParameters.Type;

const IntegrationTool = Tool.make("t3_integration", {
  description:
    "Services the user connects in T3 Code's Integrations (Linear, Gmail, Slack, …), or set up in Claude Code or Codex. `list`: {integrations: [{id, name, status, origins, providers (where it works now; empty means not connected), assistants (handles that use it)}]}. `read` {id}: one of them plus `link`, the user's page for it. Only the user connects, signs in or changes them: you never start a sign-in, edit MCP config or run a login for one. When one the user wants is not connected, `read` it and pass its `next` text to the user.",
  parameters: IntegrationParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    IntegrationAuth.IntegrationAuth,
    AssistantService.AssistantService,
  ],
})
  .annotate(Tool.Title, "Integrations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const IntegrationToolkit = Toolkit.make(IntegrationTool);
