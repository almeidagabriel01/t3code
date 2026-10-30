import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProcessResourceMonitor from "../../../diagnostics/ProcessResourceMonitor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../../../resourceTelemetry/ResourceTelemetry.ts";
import { ServerConfig } from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HostTool = Tool.make("t3_host", {
  description:
    "This machine's T3 Code server only. `status`: version, uptime, load, CPU and memory, disk free where T3 keeps its data, thread and run counts, providers and whether they are available. `resources`: whole-machine CPU and memory buckets plus the busiest processes over `windowMinutes` (1-60, default 15). `processes`: the same for the server's own process tree. `limit` caps process rows (default 10).",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "resources", "processes"]),
    windowMinutes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HostResources.HostResources,
    ProcessResourceMonitor.ProcessResourceMonitor,
    ResourceTelemetry.ResourceTelemetry,
    ProviderRegistry.ProviderRegistry,
    ServerConfig,
  ],
})
  .annotate(Tool.Title, "Host status and history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HostToolkit = Toolkit.make(HostTool);
