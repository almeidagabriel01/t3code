import {
  OrchestratorMcpFailure,
  type KanbanActor,
  type NoteConflictError,
  type NoteDocument,
  type NoteError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as NoteWorkService from "../../../notes/NoteWorkService.ts";
import * as NotesService from "../../../notes/NotesService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, newCommandId, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { NoteToolkit, type NoteParameters } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const noteFailure = (error: NoteError | NoteConflictError) =>
  error._tag === "NoteConflictError"
    ? invalid(
        "Note conflict: read the note again with t3_note read, apply your edit to the current body, and retry with its revision.",
      )
    : error.reason === "storage"
      ? unavailable()
      : invalid(error.message);

const need = <T>(value: T | undefined, name: string, action: string) =>
  value === undefined
    ? Effect.fail(invalid(`${action} needs \`${name}\`.`))
    : Effect.succeed(value);

const summary = ({ body: _body, ...note }: NoteDocument) => note;

const run = Effect.fn("mcp.note.run")(
  function* (input: NoteParameters) {
    const notes = yield* NotesService.NotesService;
    const action = input.action;
    const context = yield* loadCaller();
    if (!reads(action)) yield* assertNotLinked(context, "change this environment's notes");
    switch (action) {
      case "list": {
        const project =
          input.project === undefined ? undefined : yield* resolveProject(input.project, context);
        return yield* notes.list({
          ...(input.folder === undefined ? {} : { folder: input.folder }),
          ...(project === undefined ? {} : { project }),
        });
      }
      case "read":
        return yield* notes.read({ path: yield* need(input.path, "path", action) });
      case "write": {
        const project =
          input.project === undefined ? undefined : yield* resolveProject(input.project, context);
        return summary(
          yield* notes.write(
            {
              path: yield* need(input.path, "path", action),
              body: yield* need(input.body, "body", action),
              baseRevision: yield* need(input.baseRevision, "baseRevision", action),
              ...(project === undefined ? {} : { project }),
            },
            "agent",
          ),
        );
      }
      case "update": {
        const project = input.clearProject
          ? null
          : input.project === undefined
            ? undefined
            : yield* resolveProject(input.project, context);
        return summary(
          yield* notes.update({
            path: yield* need(input.path, "path", action),
            ...(project === undefined ? {} : { project }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
            ...(input.relate === undefined ? {} : { relate: input.relate }),
            ...(input.unrelate === undefined ? {} : { unrelate: input.unrelate }),
          }),
        );
      }
      case "move":
        return summary(
          yield* notes.move(
            {
              from: yield* need(input.path, "path", action),
              to: yield* need(input.to, "to", action),
              baseRevision: yield* need(input.baseRevision ?? undefined, "baseRevision", action),
            },
            "agent",
          ),
        );
      case "start_work": {
        const path = yield* need(input.path, "path", action);
        if (context.scope.kanban?.enabled === false) {
          return yield* invalid("The kanban board is turned off for agents in Settings.");
        }
        const projectId = yield* resolveProject(input.project, context);
        const requestId = input.clientRequestId?.trim()
          ? `mcp:${context.scope.requestNamespace}:${input.clientRequestId.trim()}`
          : yield* newCommandId();
        const actor = `agent:${context.scope.thread!.threadId}` as KanbanActor;
        const started = yield* (yield* NoteWorkService.NoteWorkService).startWork(
          { path, projectId, requestId },
          "agent",
          actor,
        );
        return { ...summary(started.note), boardId: started.boardId, cardId: started.cardId };
      }
    }
  },
  Effect.catchTags({
    NoteError: (error) => Effect.fail(noteFailure(error)),
    NoteConflictError: (error) => Effect.fail(noteFailure(error)),
  }),
);

const resolveProject = Effect.fn("mcp.note.resolveProject")(function* (
  ref: string | undefined,
  context: Effect.Success<ReturnType<typeof loadCaller>>,
) {
  if (ref === undefined) return yield* resolveProjectId(context, undefined);
  const shells = yield* (yield* Project.ProjectService)
    .listShells()
    .pipe(Effect.mapError(unavailable));
  const byId = shells.filter((shell) => shell.id === ref);
  const found =
    byId.length > 0
      ? byId
      : shells.filter((shell) => shell.title.trim().toLowerCase() === ref.trim().toLowerCase());
  if (found.length !== 1) {
    return yield* invalid(
      `${found.length === 0 ? "No" : "Several"} projects match "${ref}". Use the project id.`,
    );
  }
  return found[0]!.id as ProjectId;
});

const reads = (action: NoteParameters["action"]) => action === "list" || action === "read";

export const layer = McpToolAccess.toLayer(NoteToolkit, {
  t3_note: McpToolAccess.either(
    (input: NoteParameters) => reads(input.action),
    McpToolAccess.readsAsCaller(run),
    McpToolAccess.actsAsCaller(run),
  ),
});
