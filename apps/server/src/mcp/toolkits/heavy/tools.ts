import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HeavyCommands from "../../../heavyQueue/HeavyCommands.ts";
import * as HeavyQueue from "../../../heavyQueue/HeavyQueue.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HeavyTool = Tool.make("t3_heavy", {
  description:
    "Call before heavy work: test suites, builds, bundling, simulators or emulators, Docker, e2e runs, large installs, repo-wide checks. Action `status` with `commandLine` (the exact line you will run, `cd` included) returns `runsOn` (`mac` or `linux`: where the Runner sends it now), `reason`, and `askUser` for that machine alone: true when the command would wait there, so ask the user whether to run now or queue. Without `commandLine`, `askUser` covers this Mac. Also: `mac` (this Mac's `pressure`, `reading`, `running` and `maxRunning` slots), `linux` (the Linux runner, when on), `running` and `waiting` (with `runsOn`; `position` counts per machine), `yours` (this thread's entries), `commands` (heavy commands running now; usage is this Mac's) and `command`. Run every heavy command by prefixing it with `command` and adding `--name \"<what it is, 2-4 words>\"` before the final `--`; it runs on the machine the Runner picks, waiting for a slot there. Add `--now` there when the user chose run now: it starts at once on that same machine. Add `--runner mac` for a command that needs something only this Mac has. Action `promote` with an `id` moves a waiting entry to run next. Use it only when the user explicitly asks in this conversation; never reorder on your own.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "promote"]),
    id: Schema.optionalKey(Schema.String),
    commandLine: Schema.optionalKey(
      Schema.String.annotate({ description: "With `status`: the command line you will run." }),
    ),
  }),
  success: Schema.Record(Schema.String, Schema.Unknown),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    HostResources.HostResources,
    HeavyQueue.HeavyQueue,
    HeavyCommands.HeavyCommands,
  ],
})
  .annotate(Tool.Title, "Heavy work queue")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HeavyToolkit = Toolkit.make(HeavyTool);
