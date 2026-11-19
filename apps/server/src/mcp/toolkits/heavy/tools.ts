import { HeavyRunner, OrchestratorMcpFailure } from "@t3tools/contracts";
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
    "Call before heavy work: test suites, builds, bundling, simulators or emulators, Docker, e2e runs, large installs, repo-wide checks. Action `status` with `commandLine` (the exact line you will run, `cd` included) returns `runsOn` (`mac` or `linux`: where the Runner sends it now; `direct`: it skips the queue, as a commit with no commit hook does, so run it as written, without `command`), `reason`, and `askUser` for that machine alone: true when the command would wait there, so ask the user whether to run now or queue. In Automatic, the default, a command goes to Linux whenever Linux can start it now, and this Mac takes only what Linux can't start yet. Without `commandLine`, `askUser` covers this Mac. Also: `mac` (this Mac's `pressure`, `reading`, `running` and `maxRunning` slots), `linux` (the Linux runner, when on), `running` and `waiting` (with `runsOn`; `position` counts per machine), `yours` (this thread's entries), `commands` (heavy commands running now; usage is this Mac's) and `command`. Run every heavy command by prefixing it with `command` and adding `--name \"<what it is, 2-4 words>\"` before the final `--`; it runs on the machine the Runner picks, waiting for a slot there. Add `--now` there when the user chose run now: it starts at once on that same machine. Add `--runner mac` for a command that needs something only this Mac has. Action `promote` with an `id` moves a waiting entry to run next. Use it only when the user explicitly asks in this conversation; never reorder on your own. move_all: send every waiting job that can run on `to` (mac or linux) there. Running jobs stay. `routes`: what route memory learned (a program and folder Linux failed to run for its environment keeps the whole job that runs it on this Mac until `expiresAt`). `forget_route` with a `key` from `routes`, or `all`, sends that work back to Linux; use it only when the user asks. A key already forgotten answers `removed: 0`.",
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "promote", "move_all", "routes", "forget_route"]),
    id: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.String),
    to: Schema.optionalKey(HeavyRunner),
    commandLine: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "With `status`: the command line you will run. The answer's `runsOn` is `mac`, `linux`, or `direct` (run it as written).",
      }),
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
