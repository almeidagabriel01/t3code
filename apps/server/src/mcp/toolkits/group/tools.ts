import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const GroupParameters = Schema.Struct({
  action: Schema.Literals(["history", "assign", "transfer", "reply", "result", "cancel"]),
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
});
export type GroupParameters = typeof GroupParameters.Type;

const GroupTool = Tool.make("t3_group", {
  description: [
    "Only inside a group task (your message holds a <t3_group_task> block). Renaming a group or changing its members is not done here: that is t3_assistant `group_update`, and only when the user asks.",
    '`history` {beforeSeq?}: older group chat messages. `assign` {member, text, expectedResult?, sourceSeqs?, resources?}: give a member a subtask; you continue once it is done. expectedResult: what done looks like. sourceSeqs: #numbers of the messages it rests on. resources: what it uses alone ("folder:<path>", "browser"); subtasks sharing one run in turn. `transfer` {member, text?}: hand your whole task to a member who fits it better; stop working on it after. `reply` {seq, text}: ask the member who wrote message #seq one short question (under 500 characters, at most 2 per request); you continue with the answer. `cancel` {taskId, text?}: stop a subtask you gave, with a reason. `result` {text}: post your answer to the group explicitly; otherwise your final message is posted.',
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
  ],
})
  .annotate(Tool.Title, "Group task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const GroupToolkit = Toolkit.make(GroupTool);
