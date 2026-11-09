import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HeavyTool = Tool.make("t3_heavy", {
  description:
    'Call before heavy work: test suites, builds, bundling, simulators or emulators, Docker, e2e runs, large installs, repo-wide checks. `status` returns `askUser` (true when the machine is overloaded or other heavy work is queued: ask the user whether to run now or queue before starting), `pressure`, the `running` entry, the `waiting` entries with their `position`, `yours` (the entries this thread queued) and `command`. Queue a heavy command by prefixing it with `command` and adding `--name "<what it is, 2-4 words>"` before the final `--`; it waits its turn machine-wide. Action `promote` with an `id` moves a waiting entry to run next. Use it only when the user explicitly asks in this conversation; never reorder on your own.',
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "promote"]),
    id: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HostResources.HostResources,
    HeavyQueue.HeavyQueue,
  ],
})
  .annotate(Tool.Title, "Heavy work queue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HeavyToolkit = Toolkit.make(HeavyTool);
