import {
  AutonomyWatchEvent,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AutonomyService from "../../../autonomy/AutonomyService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

export const WatchParameters = Schema.Struct({
  action: Schema.Literals(["list", "create", "pause", "resume", "delete"]),
  watchId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  event: Schema.optional(AutonomyWatchEvent),
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  prNumber: Schema.optional(Schema.Int),
  instruction: Schema.optional(
    Schema.String.check(Schema.isMaxLength(AUTONOMY_WATCH_INSTRUCTION_MAX_LENGTH)),
  ),
  oneShot: Schema.optional(Schema.Boolean),
  expiresInMinutes: Schema.optional(Schema.Int),
});
export type WatchParameters = typeof WatchParameters.Type;

const WatchTool = Tool.make("t3_watch", {
  description:
    "Wake the assistant when something happens, with no polling and no tokens until it matches. `create`: `title`, `event` (run_finished, run_failed, pr_checks_passed, pr_checks_failed, card_moved), optional filters `projectId`, `threadId`, `prNumber`, `instruction` (what to do when it matches), `oneShot` (default true), `expiresInMinutes`. It belongs to the assistant whose thread calls it. `list`, `pause`, `resume`, `delete` take `watchId`. For a reminder at a time, use schedule_task with a `once` schedule instead.",
  parameters: WatchParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AutonomyService.AutonomyService,
  ],
}).annotate(Tool.Destructive, false);

export const WatchToolkit = Toolkit.make(WatchTool);
