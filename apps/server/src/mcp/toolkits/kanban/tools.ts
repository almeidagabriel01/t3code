import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";

import * as KanbanService from "../../../kanban/KanbanService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const KANBAN_ACTIONS = [
  "list_boards",
  "read_board",
  "read_card",
  "create_card",
  "update_card",
  "move_card",
  "comment",
  "link_thread",
  "unlink_thread",
] as const;

/** A string adds an item; an object edits the item named by `item` (id or text), or adds when it has none. */
export const ChecklistInput = Schema.Array(
  Schema.Union([
    Schema.String,
    Schema.Struct({
      item: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      done: Schema.optional(Schema.Boolean),
    }),
  ]),
);

export const KanbanParameters = Schema.Struct({
  action: Schema.Literals(KANBAN_ACTIONS),
  project: Schema.optional(Schema.String),
  card: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  priority: Schema.optional(Schema.Literals(["urgent", "high", "medium", "low", "none"])),
  labels: Schema.optional(Schema.Array(Schema.String)),
  checklist: Schema.optional(ChecklistInput),
  acceptanceCriteria: Schema.optional(ChecklistInput),
  summary: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  linkSelf: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(ThreadId),
  clientRequestId: Schema.optional(Schema.String),
});
export type KanbanParameters = typeof KanbanParameters.Type;

const KanbanTool = Tool.make("t3_kanban", {
  description:
    "The project's kanban board. Use when the user asks to create, plan, track, or update tasks or cards, or this thread is linked to a card (first message has a `kanban-card` context). Not for ordinary coding. Board: this project, or `project` (id or name). `card`: id or #number; omitted = this thread's card. `column`: id, name, or role. `checklist`, `acceptanceCriteria`: a string adds an item; `{item, done, text}` edits one by id or text. Moving into review/done needs every checklist item done and a `summary`. In a card thread: read the card, tick items as you finish, comment progress, then move to review with a summary.",
  parameters: KanbanParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    KanbanService.KanbanService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileKanbanOff);

export const KanbanToolkit = Toolkit.make(KanbanTool);
