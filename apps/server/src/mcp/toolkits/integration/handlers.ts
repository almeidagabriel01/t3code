import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { formatSettingsLink, hostedSettingsLink } from "@t3tools/shared/settingsLinks";
import * as Effect from "effect/Effect";

import * as AssistantService from "../../../assistants/AssistantService.ts";
import { agentIntegrations } from "../../../integrations/IntegrationAgentView.ts";
import * as IntegrationAuth from "../../../integrations/IntegrationAuth.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { IntegrationToolkit, type IntegrationParameters } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Settings → Integrations on this entry, mirroring `threadLinkFor`: hosted only for outside clients. */
const settingsLink = (
  scope: McpInvocationContext.McpInvocationScope,
  item: { readonly id: string; readonly name: string },
) => {
  const link = { environmentId: scope.environmentId, page: "integrations", entry: item.id };
  const hostedAppUrl = scope.client?.hostedAppUrl;
  if (hostedAppUrl !== undefined) return hostedSettingsLink(link, hostedAppUrl);
  return `[${item.name.replace(/[[\]\\\r\n]/g, " ")}](${formatSettingsLink(link)})`;
};

const run = Effect.fn("mcp.integration.run")(function* (input: IntegrationParameters) {
  const state = yield* (yield* IntegrationAuth.IntegrationAuth).state.pipe(
    Effect.mapError(() => unavailable()),
  );
  const assistants = yield* (yield* AssistantService.AssistantService).list.pipe(
    Effect.mapError(() => unavailable()),
  );
  const integrations = agentIntegrations(state, assistants);
  if (input.action === "list") return { integrations };
  const wanted = input.id?.trim().toLowerCase();
  if (wanted === undefined || wanted === "") return yield* invalid("read needs `id`.");
  const found = integrations.find(
    (item) => item.id.toLowerCase() === wanted || item.name.toLowerCase() === wanted,
  );
  if (found === undefined)
    return yield* invalid(`No integration has the id "${input.id}". Use list.`);
  const link = settingsLink(yield* McpInvocationContext.McpInvocationContext, found);
  return {
    ...found,
    link,
    ...(found.providers.length > 0
      ? {}
      : { next: `Ask the user to connect ${found.name} from Integrations: ${link}` }),
  };
});

export const layer = McpToolAccess.toLayer(IntegrationToolkit, {
  t3_integration: McpToolAccess.reads(run),
});
