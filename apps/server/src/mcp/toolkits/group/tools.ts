import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const GroupParameters = Schema.Struct({
  action: Schema.Literals([
    "history",
    "assign",
    "transfer",
    "reply",
    "result",
    "cancel",
    "routines",
    "routine_save",
    "routine_run",
    "routine_delete",
  ]),
  /** history: messages before this number; the newest page when absent. */
  beforeSeq: Schema.optional(Schema.Int),
  /** assign, transfer: the member's handle. */
  member: Schema.optional(Text(64)),
  /** assign: the subtask. transfer: a note for the new owner. result: your answer. cancel: why. */
  text: Schema.optional(Text(20_000)),
  /** reply: the number of the member message you answer (the #N in the chat). */
  seq: Schema.optional(Schema.Int),
  /** assign: what done looks like. */
  expectedResult: Schema.optional(Text(500)),
  /** assign: chat message numbers the subtask is based on. */
  sourceSeqs: Schema.optional(Schema.Array(Schema.Int).check(Schema.isMaxLength(8))),
  /** assign: what it uses exclusively, e.g. "folder:/abs/path", "browser". */
  resources: Schema.optional(Schema.Array(Text(200)).check(Schema.isMaxLength(8))),
  /** cancel: the subtask's id. */
  taskId: Schema.optional(Text(128)),
  /** routine_save (to edit), routine_run, routine_delete: the routine's id. */
  routineId: Schema.optional(Text(128)),
  /** routine_save: a short name. `text` is the request the routine posts. */
  title: Schema.optional(Text(80)),
  /** routine_save: the schedule is `runAt` (ISO with offset, once), `at` (HH:MM local, daily or on `weekdays`) or `everyMinutes`. */
  runAt: Schema.optional(Text(40)),
  at: Schema.optional(Text(5)),
  weekdays: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
      Schema.isMaxLength(7),
    ),
  ),
  everyMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** routine_save: false pauses, true resumes. */
  enabled: Schema.optional(Schema.Boolean),
  /** routine_save: stop after this many runs; null removes the limit. */
  maxRuns: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
  /** routine_save: for a daily or weekly routine, what to do when the server was off at its time. */
  missedRun: Schema.optional(Schema.Literals(["skip", "once"])),
});
export type GroupParameters = typeof GroupParameters.Type;

const GroupTool = Tool.make("t3_group", {
  description: [
    "Only inside a group task (your message holds a <t3_group_task> block). Renaming a group or changing its members is not done here: that is t3_assistant `group_update`, and only when the user asks.",
    '`history` {beforeSeq?}: older group chat messages. `assign` {member, text, expectedResult?, sourceSeqs?, resources?}: give a member a subtask; you continue once it is done. expectedResult: what done looks like. sourceSeqs: #numbers of the messages it rests on. resources: what it uses alone ("folder:<path>", "browser"); subtasks sharing one run in turn. `transfer` {member, text?}: hand your whole task to a member who fits it better; stop working on it after. `reply` {seq, text}: ask the member who wrote message #seq one short question (under 500 characters, at most 2 per request); you continue with the answer. `cancel` {taskId, text?}: stop a subtask you gave, with a reason. `result` {text}: post your answer to the group explicitly; otherwise your final message is posted.',
    "Routines of this group: `routines` lists them. `routine_save` {routineId? (to edit), title?, text, runAt | at (+weekdays 0-6) | everyMinutes, enabled?, maxRuns?, missedRun?: skip|once} creates or edits one that posts `text` in this chat on a schedule; `enabled` false pauses, true resumes. `routine_run` {routineId} runs it now; `routine_delete` {routineId}. Creating, editing, pausing, running or deleting a routine works only when the user asked for it in this group; otherwise it is refused, so tell the user and do not retry. Each change leaves a line in the chat. For a schedule in this group use these, not schedule_task.",
    "Your final message is posted to the group chat as you, so write it for the group.",
  ].join(" "),
  parameters: GroupParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AssistantGroups.AssistantGroups,
    ScheduledTaskService.ScheduledTaskService,
  ],
})
  .annotate(Tool.Title, "Group task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GroupToolkit = Toolkit.make(GroupTool);
