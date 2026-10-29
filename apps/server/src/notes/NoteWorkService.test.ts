import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type KanbanBoardSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Config from "../config.ts";
import * as CardImages from "../kanban/CardImages.ts";
import * as Kanban from "../kanban/KanbanService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Notes from "./NotesService.ts";
import { cleanupRecorder, notesLayer } from "./NotesTestkit.ts";
import * as Work from "./NoteWorkService.ts";

const projectId = ProjectId.make("project-1");

const workLayer = (cleaned: Array<string>) =>
  Work.layer.pipe(
    Layer.provideMerge(
      Kanban.layer.pipe(
        Layer.provide(CardImages.layerLive.pipe(Layer.provide(cleanupRecorder(cleaned)))),
        Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
      ),
    ),
    Layer.provideMerge(notesLayer({ cleaned })),
  );

const boards = Effect.gen(function* () {
  const kanban = yield* Kanban.KanbanService;
  const head = yield* Stream.runHead(kanban.subscribe());
  return head._tag === "Some" && head.value.kind === "snapshot"
    ? head.value.boards
    : ([] as ReadonlyArray<KanbanBoardSnapshot>);
});

it.effect("start work creates one linked card per request id", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const work = yield* Work.NoteWorkService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    // A note written outside T3 Code has no id until start work gives it one.
    yield* fs.writeFileString(`${notesDir}/idea.md`, "# Ship notes\nDetails\n");
    const first = yield* work.startWork(
      { path: "idea.md", projectId, requestId: "request-1" },
      "user",
      "user",
    );
    assert.isNotNull(first.note.id);
    assert.deepStrictEqual(first.note.card, { cardId: first.cardId, projectId });
    assert.strictEqual(first.note.body, "# Ship notes\nDetails\n");

    const retry = yield* work.startWork(
      { path: "idea.md", projectId, requestId: "request-1" },
      "user",
      "user",
    );
    assert.strictEqual(retry.cardId, first.cardId);
    assert.strictEqual(retry.note.revision, first.note.revision);

    const [board] = yield* boards;
    assert.strictEqual(board?.projectId, projectId);
    assert.strictEqual(board?.cards.length, 1);
    const card = board!.cards[0]!;
    assert.strictEqual(card.id, first.cardId);
    assert.strictEqual(card.title, "Ship notes");
    assert.strictEqual(card.description, "# Ship notes\nDetails\n");
    assert.strictEqual(card.columnId, board!.columns.find((c) => c.role === "backlog")?.id);
    assert.deepStrictEqual((yield* notes.read({ path: "idea.md" })).card, first.note.card);
  }).pipe(Effect.provide(workLayer([]))),
);

it.effect("a retry after the card was created but not linked links that same card", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const work = yield* Work.NoteWorkService;
    const note = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    const missing = yield* work
      .startWork(
        { path: "missing.md", projectId, requestId: "request-1" },
        "agent",
        "agent:thread-1",
      )
      .pipe(Effect.flip);
    assert.strictEqual(missing.reason, "not_found");
    const kanban = yield* Kanban.KanbanService;
    const { boardId } = yield* kanban.boardEnsure({
      commandId: CommandId.make(`note-work:${note.id}:request-2:board`),
      projectId,
    });
    const created = yield* kanban.cardCreate({
      commandId: CommandId.make(`note-work:${note.id}:request-2:card`),
      boardId: boardId!,
      title: "A",
    });
    const started = yield* work.startWork(
      { path: "a.md", projectId, requestId: "request-2" },
      "agent",
      "agent:thread-1",
    );
    assert.strictEqual(started.cardId, created.cardId);
    assert.strictEqual(started.note.updatedBy, "agent");
    assert.strictEqual((yield* boards)[0]?.cards.length, 1);
  }).pipe(Effect.provide(workLayer([]))),
);

it.effect("the card gets its own copies of the note's images", () => {
  const cleaned: Array<string> = [];
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const work = yield* Work.NoteWorkService;
    const fs = yield* FileSystem.FileSystem;
    const { attachmentsDir } = yield* Config.ServerConfig;
    const pendingId = "pending-0b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f";
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFile(`${attachmentsDir}/${pendingId}.png`, new Uint8Array([7]));
    const note = yield* notes.write(
      { path: "shot.md", body: `# Shot\n![a](t3-attachment:${pendingId})\n`, baseRevision: null },
      "user",
    );
    const started = yield* work.startWork(
      { path: note.path, projectId, requestId: "request-1" },
      "user",
      "user",
    );
    const card = (yield* boards)[0]!.cards[0]!;
    const cardImage = /t3-attachment:([a-z0-9-]+)\)/.exec(card.description)![1]!;
    assert.isTrue(cardImage.startsWith(`card-${started.cardId}-`));
    assert.deepStrictEqual(
      Array.from(yield* fs.readFile(`${attachmentsDir}/${cardImage}.png`)),
      [7],
    );
    yield* notes.delete({ path: note.path, baseRevision: started.note.revision });
    assert.isTrue(cleaned.every((id) => id.startsWith(`note-${note.id}-`)));
    assert.isTrue(yield* fs.exists(`${attachmentsDir}/${cardImage}.png`));
  }).pipe(Effect.provide(workLayer(cleaned)));
});
