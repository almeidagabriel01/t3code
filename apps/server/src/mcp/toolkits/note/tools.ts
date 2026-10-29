import { NoteRevision, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as NoteWorkService from "../../../notes/NoteWorkService.ts";
import * as NotesService from "../../../notes/NotesService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const NOTE_ACTIONS = ["list", "read", "write", "update", "move", "start_work"] as const;

export const NoteParameters = Schema.Struct({
  action: Schema.Literals(NOTE_ACTIONS),
  path: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  baseRevision: Schema.optional(Schema.NullOr(NoteRevision)),
  to: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
  relate: Schema.optional(ThreadId),
  unrelate: Schema.optional(ThreadId),
  project: Schema.optional(Schema.String),
  clientRequestId: Schema.optional(Schema.String),
});
export type NoteParameters = typeof NoteParameters.Type;

const NoteTool = Tool.make("t3_note", {
  description:
    "Markdown notes on this environment, shared with the user, who may edit the same files. Use when the user asks to read, write or organise notes, or to turn a note into a kanban card. `path`: `note.md` or `folder/note.md`. `list` (optional `folder`) returns summaries without bodies; `read` returns `body` and `revision`. `write` replaces the whole body: pass `baseRevision` from `read`, or null to create; on a conflict read again, reapply your edit, and retry. `update` sets `pinned` or `relate`/`unrelate` a thread id. `move` renames to `to` with `baseRevision`. `start_work` creates one kanban card from the note on `project`'s board (id or name; default this thread's project) and links it to the note.",
  parameters: NoteParameters,
  success: Schema.Record(Schema.String, Schema.Json),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    NotesService.NotesService,
    NoteWorkService.NoteWorkService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
}).annotate(Tool.Destructive, false);

export const NoteToolkit = Toolkit.make(NoteTool);
