import {
  CommandId,
  NoteError,
  type KanbanActor,
  type KanbanError,
  type NoteAuthor,
  type NotesStartWorkInput,
  type NotesStartWorkResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KanbanService from "../kanban/KanbanService.ts";
import * as NoteImages from "./NoteImages.ts";
import * as NotesService from "./NotesService.ts";

/** Kanban card descriptions are capped below a note body's limit. */
const CARD_DESCRIPTION_MAX_CHARS = 100_000;
const TRUNCATION_NOTICE = "\n\n[Truncated: the note continues in the note itself.]";

/** Cuts at a code point boundary and says so, so a long note never silently loses its tail. */
export const cardDescription = (body: string) => {
  if (body.length <= CARD_DESCRIPTION_MAX_CHARS) return body;
  const cut = body.slice(0, CARD_DESCRIPTION_MAX_CHARS - TRUNCATION_NOTICE.length);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}${TRUNCATION_NOTICE}`;
};

export class NoteWorkService extends Context.Service<
  NoteWorkService,
  {
    /** Creates one kanban card from the note on the project's board and links it to the note. */
    readonly startWork: (
      input: NotesStartWorkInput,
      author: NoteAuthor,
      actor: KanbanActor,
    ) => Effect.Effect<NotesStartWorkResult, NoteError>;
  }
>()("t3/notes/NoteWorkService") {}

const make = Effect.gen(function* () {
  const notes = yield* NotesService.NotesService;
  const kanban = yield* KanbanService.KanbanService;
  const images = yield* NoteImages.NoteImages;
  const startFailed = (error: KanbanError) =>
    new NoteError({
      reason: error.kind === "internal" ? "storage" : "invalid",
      message: `The kanban card could not be created: ${error.message}`,
    });
  const startWork = Effect.fn("NoteWorkService.startWork")(
    function* (input: NotesStartWorkInput, author: NoteAuthor, actor: KanbanActor) {
      const note = yield* notes.identify(input.path);
      if (note.card) {
        // One note, one card: a second click returns the card the first created while it exists.
        const existing = yield* kanban.cardFamily(note.card.cardId);
        if (existing) return { note, boardId: existing.board.id, cardId: existing.card.id };
      }
      // Kanban stores each command's result, so a retry with the same request id gets the card the
      // first attempt created, even when that attempt failed before linking it to the note.
      const commandKey = `note-work:${note.id}:${input.requestId}`;
      const board = yield* kanban.boardEnsure({
        commandId: CommandId.make(`${commandKey}:board`),
        projectId: input.projectId,
        actor,
      });
      const description = yield* images.copyAsPending(note.id, cardDescription(note.body));
      const card = yield* kanban.cardCreate({
        commandId: CommandId.make(`${commandKey}:card`),
        boardId: board.boardId!,
        ...(input.columnId === undefined ? {} : { columnId: input.columnId }),
        title: note.title.trim() || "Untitled note",
        description,
        actor,
      });
      const linked = yield* notes.linkCard(
        input.path,
        { cardId: card.cardId!, projectId: input.projectId },
        author,
      );
      return { note: linked, boardId: card.boardId!, cardId: card.cardId! };
    },
    Effect.catchTags({ KanbanError: (error) => Effect.fail(startFailed(error)) }),
  );
  return NoteWorkService.of({ startWork });
});

export const layer = Layer.effect(NoteWorkService, make);
