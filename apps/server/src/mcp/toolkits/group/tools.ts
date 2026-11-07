import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AssistantGroups from "../../../assistants/AssistantGroups.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const GroupParameters = Schema.Struct({
  action: Schema.Literals(["history", "assign", "transfer", "reply", "result"]),
  /** history: messages before this number; the newest page when absent. */
  beforeSeq: Schema.optional(Schema.Int),
  /** assign, transfer: the member's handle. */
  member: Schema.optional(Text(64)),
  /** assign: the subtask. transfer: a note for the new owner. result: your answer. */
  text: Schema.optional(Text(20_000)),
  /** reply: the number of the member message you answer (the #N in the chat). */
  seq: Schema.optional(Schema.Int),
});
export type GroupParameters = typeof GroupParameters.Type;

const GroupTool = Tool.make("t3_group", {
  description: [
    "Only inside a group task (your message holds a <t3_group_task> block).",
    "`history` {beforeSeq?}: older group chat messages. `assign` {member, text}: give a member a subtask; you continue once it is done. `transfer` {member, text?}: hand your whole task to a member who fits it better; stop working on it after. `reply` {seq, text}: ask the member who wrote message #seq one short question (under 500 characters, at most 2 per request); you continue with the answer. `result` {text}: post your answer to the group explicitly; otherwise your final message is posted.",
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
