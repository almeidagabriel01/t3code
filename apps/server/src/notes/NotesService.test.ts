import { assert, it } from "@effect/vitest";
import {
  KanbanCardId,
  NOTE_TITLE_MAX_LENGTH,
  NoteSummary,
  ProjectId,
  ThreadId,
  type NotesEvent,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Config from "../config.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import { InvalidFrontmatterError, parseNote, serializeNote } from "./frontmatter.ts";
import * as Notes from "./NotesService.ts";
import { notesLayer as layer, racing } from "./NotesTestkit.ts";

const isSummary = Schema.is(NoteSummary);

/** A watcher fed by the test, so outside edits are delivered without a real file watcher. */
const queuedWatcher = (changes: Queue.Queue<FileSystem.WatchEvent>) =>
  layer({
    transformFs: (fs) => ({
      ...fs,
      watch: (_directory, options) =>
        Stream.unwrap(
          Effect.sync(() => {
            options?.onReady?.();
            return Stream.fromQueue(changes);
          }),
        ),
    }),
  });

it.effect("reattaches the notes watcher and resyncs edits made while it was detached", () =>
  Effect.gen(function* () {
    const fail = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
    const seen = yield* Queue.unbounded<NotesEvent>();
    let attachments = 0;
    const testLayer = layer({
      transformFs: (fs) => ({
        ...fs,
        watch: (_directory, options) =>
          Stream.unwrap(
            Effect.sync(() => {
              attachments++;
              options?.onReady?.();
              return attachments === 1
                ? Stream.fromEffect(
                    Effect.gen(function* () {
                      yield* Deferred.await(fail);
                      return yield* PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "watch",
                      });
                    }),
                  ).pipe(Stream.ensuring(Deferred.succeed(closed, undefined)))
                : Stream.fromQueue(changes);
            }),
          ),
      }),
    });
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      yield* notes.subscribe.pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkScoped,
      );
      assert.equal((yield* Queue.take(seen)).type, "snapshot");
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(fail, undefined);
      yield* Deferred.await(closed);
      yield* fs.writeFileString(`${notesDir}/watcher.md`, "# Detached edit\n");
      yield* TestClock.adjust("1100 millis");
      assert.equal(attachments, 2);
      const event = yield* Queue.take(seen);
      assert.equal(event.type, "upserted");
      if (event.type === "upserted") assert.equal(event.note.path, "watcher.md");
      yield* fs.writeFileString(`${notesDir}/watcher.md`, "# Second edit\n");
      yield* Queue.offer(changes, { _tag: "Update", path: "watcher.md" });
      yield* TestClock.adjust("100 millis");
      assert.equal((yield* Queue.take(seen)).type, "upserted");
      yield* fs.remove(`${notesDir}/watcher.md`);
      yield* Queue.offer(changes, { _tag: "Remove", path: "watcher.md" });
      yield* TestClock.adjust("100 millis");
      assert.equal((yield* Queue.take(seen)).type, "removed");
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped),
);

it.effect("publishes an outside edit and deletion picked up by the watcher", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const seen = yield* Queue.unbounded<NotesEvent>();
      yield* notes.subscribe.pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkScoped,
      );
      assert.equal((yield* Queue.take(seen)).type, "snapshot");
      yield* fs.makeDirectory(`${notesDir}/project`);
      yield* fs.writeFileString(`${notesDir}/project/task.md`, "# External\n- [x] done\n");
      yield* Queue.offer(changes, { _tag: "Create", path: "project/task.md" });
      yield* TestClock.adjust("100 millis");
      const upserted = yield* Queue.take(seen);
      assert.equal(upserted.type, "upserted");
      if (upserted.type === "upserted") {
        assert.equal(upserted.note.path, "project/task.md");
        assert.equal(upserted.note.title, "External");
        assert.isNull(upserted.note.id);
      }
      yield* fs.remove(`${notesDir}/project/task.md`);
      yield* Queue.offer(changes, { _tag: "Remove", path: "project/task.md" });
      yield* TestClock.adjust("100 millis");
      assert.deepStrictEqual(yield* Queue.take(seen), {
        type: "removed",
        path: "project/task.md",
      });
    }).pipe(Effect.provide(queuedWatcher(changes)));
  }).pipe(Effect.scoped),
);

it("round trips unknown and legacy frontmatter keys, comments, and body", () => {
  const source =
    "---\n# Keep this\ncustom:\n  nested: [one, two]\nstatus: doing\nthreads: [local]\nupdatedBy: user\n---\n# Title\n\n- [ ] task\n";
  const parsed = parseNote(source);
  assert.isNull(parsed.id);
  assert.isNull(parsed.card);
  const next = serializeNote({ ...parsed, updatedBy: "agent" });
  assert.include(next, "# Keep this");
  assert.include(next, "nested: [ one, two ]");
  assert.include(next, "status: doing");
  assert.include(next, "threads: [ local ]");
  assert.strictEqual(parseNote(next).body, parsed.body);
  assert.strictEqual(parseNote(next).updatedBy, "agent");
  const empty = parseNote("---\n---\nbody\n");
  assert.strictEqual(empty.body, "body\n");
  assert.strictEqual(parseNote(serializeNote({ ...empty, updatedBy: "user" })).body, "body\n");
});

it("round trips the id, card link, pin and related threads", () => {
  const parsed = parseNote(
    "---\nid: 4d0c6d1e-1a2b-4c3d-8e9f-001122334455\ncard: card-1\ncardProject: project-1\npinned: true\nrelated: [thread-1]\ncustom: keep\n---\nBody\n",
  );
  assert.strictEqual(parsed.id, "4d0c6d1e-1a2b-4c3d-8e9f-001122334455");
  assert.deepStrictEqual(parsed.card, {
    cardId: KanbanCardId.make("card-1"),
    projectId: ProjectId.make("project-1"),
  });
  assert.isTrue(parsed.pinned);
  assert.deepStrictEqual(parsed.related, [ThreadId.make("thread-1")]);
  assert.deepStrictEqual(parseNote(serializeNote(parsed)), {
    ...parsed,
    metadata: parseNote(serializeNote(parsed)).metadata,
  });
  const cleared = serializeNote({ ...parsed, pinned: false, related: [], card: null });
  for (const key of ["pinned:", "related:", "card:", "cardProject:"])
    assert.notInclude(cleared, key);
  assert.include(cleared, "custom: keep");
  const scoped = parseNote("---\nproject: project-2\n---\nB\n");
  assert.strictEqual(scoped.project, ProjectId.make("project-2"));
  assert.include(serializeNote(scoped), "project: project-2");
  assert.notInclude(serializeNote({ ...scoped, project: null }), "project:");
  assert.isNull(parseNote("---\nid: Not A Valid Id\n---\n").id);
});

it("frontmatter a person wrote loosely is understood and survives writes untouched", () => {
  // [source, what the managed fields read as, key text that must survive a write of another field]
  const cases: ReadonlyArray<
    readonly [
      string,
      Partial<Record<"id" | "pinned" | "related" | "card" | "project", unknown>>,
      string,
    ]
  > = [
    ["related: thread-1", { related: ["thread-1"] }, "related: thread-1"],
    ["related: [a, b]\nrelated2: x", { related: ["a", "b"] }, "related: [ a, b ]"],
    ["card: 1234\ncardProject: p-1", { card: { cardId: "1234", projectId: "p-1" } }, "card: 1234"],
    ["card: card-1", { card: null }, "card: card-1"],
    ["cardProject: p-1", { card: null }, "cardProject: p-1"],
    ['pinned: "true"', { pinned: true }, 'pinned: "true"'],
    ["pinned: yes", { pinned: true }, "pinned: yes"],
    ["pinned: True", { pinned: true }, "pinned: True"],
    ["pinned: 0", { pinned: false }, "pinned: 0"],
    ["id: 1234", { id: "1234" }, "id: 1234"],
    ["project: 77", { project: "77" }, "project: 77"],
  ];
  for (const [header, expected, kept] of cases) {
    const parsed = parseNote(`---\n${header}\n---\nBody\n`);
    for (const [key, value] of Object.entries(expected))
      assert.deepStrictEqual(parsed[key as "id"], value, header);
    const written = serializeNote({ ...parsed, updatedBy: "agent" });
    assert.include(written, kept, header);
    assert.strictEqual(parseNote(written).body, "Body\n");
    for (const line of header.split("\n")) assert.include(written, line.split(":")[0]!, header);
  }
  // Changing a field still rewrites exactly that field.
  const pinned = parseNote("---\npinned: yes\nrelated: thread-1\n---\nB\n");
  const unpinned = serializeNote({ ...pinned, pinned: false });
  assert.notInclude(unpinned, "pinned");
  assert.include(unpinned, "related: thread-1");
  // `...` closes a header, and a block that is not a map is body text.
  assert.isTrue(parseNote("---\npinned: true\n...\nB\n").pinned);
  const rule = "---\njust a sentence\n---\nB\n";
  assert.strictEqual(parseNote(rule).body, rule);
  for (const broken of ["---\na: 1\na: 2\n---\nB\n", "---\na: [1\n---\nB\n"])
    assert.throws(() => parseNote(broken), InvalidFrontmatterError);
});

it("recognizes frontmatter only at byte zero or after a BOM", () => {
  for (const body of [
    "# Keep this heading\n\n---\ncustom: yes\n---\nTail\n",
    "\n---\ncustom: yes\n---\nbody\n",
  ]) {
    const parsed = parseNote(body);
    assert.strictEqual(parsed.body, body);
    assert.strictEqual(parsed.metadata, null);
    assert.strictEqual(parseNote(serializeNote(parsed)).body, body);
  }
  assert.isTrue(parseNote("﻿---\npinned: true\n---\nbody").pinned);
});

it.effect("CRUD refuses stale writes, carries the current note, and emits ordered changes", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const snapshots = yield* Deferred.make<void>();
    const stream = yield* notes.subscribe.pipe(
      Stream.tap((event) =>
        event.type === "snapshot" ? Deferred.succeed(snapshots, undefined) : Effect.void,
      ),
      Stream.take(5),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(snapshots);
    const initial = yield* notes.write(
      { path: "project/a.md", body: "# A\n- [ ] task\n", baseRevision: null },
      "user",
    );
    assert.isNotNull(initial.id);
    const changed = yield* notes.write(
      { path: initial.path, body: "# A\n- [x] task\n", baseRevision: initial.revision },
      "agent",
    );
    assert.strictEqual(changed.id, initial.id);
    const conflict = yield* notes
      .write({ path: initial.path, body: "stale", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    if (conflict._tag === "NoteConflictError") assert.deepStrictEqual(conflict.current, changed);
    const exists = yield* notes
      .write({ path: initial.path, body: "overwrite", baseRevision: null }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(exists._tag, "NoteError");
    if (exists._tag === "NoteError") assert.strictEqual(exists.reason, "exists");
    const moved = yield* notes.move(
      { from: changed.path, to: "b.md", baseRevision: changed.revision },
      "user",
    );
    assert.strictEqual(moved.updatedBy, "user");
    assert.strictEqual(moved.id, initial.id);
    const events = yield* Fiber.join(stream);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["snapshot", "upserted", "upserted", "upserted", "removed"],
    );
    assert.strictEqual((yield* notes.list({ folder: "project" })).notes.length, 0);
    yield* notes.delete({ path: moved.path, baseRevision: moved.revision });
    assert.strictEqual(
      (yield* notes.read({ path: moved.path }).pipe(Effect.flip)).reason,
      "not_found",
    );
  }).pipe(Effect.provide(layer())),
);

it.effect("serializes concurrent writers so exactly one revision wins", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write(
      { path: "a.md", body: "initial", baseRevision: null },
      "user",
    );
    const results = yield* Effect.forEach(
      ["left", "right"],
      (body) =>
        notes
          .write({ path: initial.path, body, baseRevision: initial.revision }, "agent")
          .pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
    assert.strictEqual(results.filter((result) => result._tag === "Failure").length, 1);
  }).pipe(Effect.provide(layer())),
);

it.effect("loads legacy id-less files with a status key and assigns an id on the first write", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    yield* fs.writeFileString(
      `${notesDir}/external.md`,
      "---\ncustom: yes\nstatus: done\nthreads: [local]\n---\n# External\n",
    );
    const initial = yield* notes.read({ path: "external.md" });
    assert.isNull(initial.id);
    assert.strictEqual(initial.updatedBy, null);
    assert.strictEqual(initial.title, "External");
    assert.strictEqual(
      yield* fs.readFileString(`${notesDir}/external.md`),
      "---\ncustom: yes\nstatus: done\nthreads: [local]\n---\n# External\n",
    );
    const saved = yield* notes.write(
      { path: initial.path, baseRevision: initial.revision, body: "changed\n" },
      "agent",
    );
    assert.isNotNull(saved.id);
    const moved = yield* notes.move(
      { from: saved.path, to: "folder/moved.md", baseRevision: saved.revision },
      "user",
    );
    assert.strictEqual(moved.id, saved.id);
    const raw = yield* fs.readFileString(`${notesDir}/folder/moved.md`);
    assert.include(raw, "custom: yes");
    assert.include(raw, "status: done");
    assert.include(raw, `id: ${saved.id}`);
  }).pipe(Effect.provide(layer())),
);

it.effect("rejects invalid paths, escaping directory/file symlinks and oversized bodies", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { notesDir } = yield* Config.ServerConfig;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-notes-outside-" });
    yield* fs.writeFileString(path.join(outside, "a.md"), "private");
    yield* fs.symlink(outside, path.join(notesDir, "escape"));
    yield* fs.symlink(path.join(outside, "a.md"), path.join(notesDir, "link.md"));
    for (const name of [
      "../a.md",
      "/tmp/a.md",
      ".hidden.md",
      "a/b/c.md",
      "escape/a.md",
      "link.md",
    ]) {
      const error = yield* notes
        .write({ path: name, body: "x", baseRevision: null }, "agent")
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NoteError");
      if (error._tag === "NoteError") assert.strictEqual(error.reason, "invalid_path", name);
    }
    assert.strictEqual(yield* fs.readFileString(path.join(outside, "a.md")), "private");
    const large = yield* notes
      .write({ path: "large.md", body: "한".repeat(400000), baseRevision: null }, "user")
      .pipe(Effect.flip);
    if (large._tag === "NoteError") assert.strictEqual(large.reason, "too_large");
    else assert.fail("Expected too_large");
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("rejects case aliases instead of publishing a second note identity", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write(
      { path: "Task.md", body: "original", baseRevision: null },
      "user",
    );
    if (!(yield* fs.exists(`${notesDir}/task.md`))) return;
    const result = yield* notes
      .write({ path: "task.md", body: "alias", baseRevision: initial.revision }, "agent")
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure" && result.failure._tag === "NoteError")
      assert.strictEqual(result.failure.reason, "invalid_path");
    assert.strictEqual((yield* notes.read({ path: "Task.md" })).body, "original");
  }).pipe(Effect.provide(layer())),
);

it.effect("directory replacement after validation cannot write outside the notes root", () =>
  Effect.gen(function* () {
    let armed = false;
    const swapped = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-notes-race-outside-" });
      yield* fs.makeDirectory(`${notesDir}/folder`);
      armed = true;
      const write = yield* notes
        .write({ path: "folder/new.md", body: "must stay inside", baseRevision: null }, "agent")
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(swapped);
      yield* fs.rename(`${notesDir}/folder`, `${notesDir}/original`);
      yield* fs.symlink(outside, `${notesDir}/folder`);
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(write);
      assert.deepStrictEqual(yield* fs.readDirectory(outside), []);
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(
      Effect.provide(
        layer({
          transformFs: (fs) => ({
            ...fs,
            makeTempDirectoryScoped: (options) =>
              Effect.gen(function* () {
                if (armed && options?.prefix === ".note-") {
                  armed = false;
                  yield* Deferred.succeed(swapped, undefined);
                  yield* Deferred.await(release);
                }
                return yield* fs.makeTempDirectoryScoped(options);
              }),
          }),
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("read, move and delete refuse file symlinks and folder case aliases", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write(
      { path: "Project/Task.md", body: "keep", baseRevision: null },
      "user",
    );
    yield* fs.symlink(`${notesDir}/Project/Task.md`, `${notesDir}/link.md`);
    const paths = ["link.md"];
    if (yield* fs.exists(`${notesDir}/project/Task.md`))
      paths.push("project/Task.md", "Project/task.md");
    for (const path of paths) {
      const read = yield* notes.read({ path }).pipe(Effect.flip);
      assert.strictEqual(read.reason, "invalid_path");
      const move = yield* notes
        .move({ from: path, to: "moved.md", baseRevision: initial.revision }, "agent")
        .pipe(Effect.flip);
      assert.strictEqual(move._tag, "NoteError");
      if (move._tag === "NoteError") assert.strictEqual(move.reason, "invalid_path");
      const removed = yield* notes
        .delete({ path, baseRevision: initial.revision })
        .pipe(Effect.flip);
      assert.strictEqual(removed._tag, "NoteError");
      if (removed._tag === "NoteError") assert.strictEqual(removed.reason, "invalid_path");
    }
    assert.strictEqual((yield* notes.read({ path: initial.path })).body, "keep");
  }).pipe(Effect.provide(layer())),
);

// An external writer acting while a note write prepares its temp file, after the revision check.
it.effect("an external edit after the revision check is refused, not overwritten", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    external.arm(fs.writeFileString(`${notesDir}/a.md`, "# Terminal\n").pipe(Effect.orDie));
    const conflict = yield* notes
      .write({ path: "a.md", body: "# Mine\n", baseRevision: initial.revision }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    if (conflict._tag === "NoteConflictError")
      assert.strictEqual(conflict.current.body, "# Terminal\n");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
  }).pipe(Effect.provide(external.layer));
});

it.effect("creating a note refuses a file another process created meanwhile", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    external.arm(fs.writeFileString(`${notesDir}/new.md`, "terminal\n").pipe(Effect.orDie));
    const exists = yield* notes
      .write({ path: "new.md", body: "mine\n", baseRevision: null }, "agent")
      .pipe(Effect.flip);
    assert.strictEqual(exists._tag === "NoteError" && exists.reason, "exists");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/new.md`), "terminal\n");
  }).pipe(Effect.provide(external.layer));
});

it.effect("a move keeps a source edited during the move and leaves no destination", () => {
  const external = racing();
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const initial = yield* notes.write({ path: "a.md", body: "# A\n", baseRevision: null }, "user");
    external.arm(fs.writeFileString(`${notesDir}/a.md`, "# Terminal\n").pipe(Effect.orDie));
    const conflict = yield* notes
      .move({ from: "a.md", to: "b.md", baseRevision: initial.revision }, "user")
      .pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "NoteConflictError");
    assert.strictEqual(yield* fs.readFileString(`${notesDir}/a.md`), "# Terminal\n");
    assert.isFalse(yield* fs.exists(`${notesDir}/b.md`));
  }).pipe(Effect.provide(external.layer));
});

it.effect(
  "linking a card re-reads a note edited during the update, and unlinking clears it",
  () => {
    const external = racing();
    return Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const initial = yield* notes.write(
        { path: "a.md", body: "# A\n", baseRevision: null },
        "user",
      );
      external.arm(
        fs
          .writeFileString(`${notesDir}/a.md`, `---\nid: ${initial.id}\n---\n# Terminal\n`)
          .pipe(Effect.orDie),
      );
      const card = { cardId: KanbanCardId.make("card-1"), projectId: ProjectId.make("project-1") };
      const note = yield* notes.linkCard("a.md", card, "agent");
      assert.strictEqual(note.body, "# Terminal\n");
      assert.deepStrictEqual(note.card, card);
      assert.strictEqual(note.id, initial.id);
      const unlinked = yield* notes.update({ path: "a.md", card: null });
      assert.isNull(unlinked.card);
      assert.strictEqual(unlinked.body, "# Terminal\n");
      assert.strictEqual(
        (yield* notes.update({ path: "a.md", card: null })).revision,
        unlinked.revision,
      );
    }).pipe(Effect.provide(external.layer));
  },
);

it.effect("uses the first body line as title and bounds titles and previews", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const note = yield* notes.write(
      {
        path: "filename.md",
        body: "\n- [x] First task\n\n> More   context\n```ts\ncode\n```\n",
        baseRevision: null,
      },
      "user",
    );
    assert.strictEqual(note.title, "First task");
    assert.strictEqual(note.preview, "More context code");
    const withImage = yield* notes.write(
      {
        path: "image.md",
        body: "Plan\n\n![shot.png](https://example.com/a.png) after\n",
        baseRevision: null,
      },
      "user",
    );
    assert.strictEqual(withImage.preview, "after");
    const long = yield* notes.write(
      {
        path: "long.md",
        body: `# ${"x".repeat(NOTE_TITLE_MAX_LENGTH - 2)}😀tail\n${"y".repeat(138)}😀more`,
        baseRevision: null,
      },
      "user",
    );
    assert.isAtMost(long.title.length, NOTE_TITLE_MAX_LENGTH);
    assert.isTrue(long.title.endsWith("x…"));
    assert.strictEqual(long.preview, `${"y".repeat(138)}…`);
    const empty = yield* notes.write({ path: "empty.md", body: "\n", baseRevision: null }, "user");
    assert.strictEqual(empty.title, "empty");
    assert.isTrue(isSummary((yield* notes.list({})).notes[0]));
  }).pipe(Effect.provide(layer())),
);

it.effect("pinned survives body writes and moves, and repeated updates do not rewrite", () =>
  Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write(
      { path: "a.md", body: "# A\nContext", baseRevision: null },
      "agent",
    );
    const pinned = yield* notes.update({ path: initial.path, pinned: true });
    assert.isTrue(pinned.pinned);
    assert.strictEqual(pinned.updatedBy, "agent");
    const saved = yield* notes.write(
      { path: pinned.path, body: "new body", baseRevision: pinned.revision },
      "user",
    );
    assert.isTrue(saved.pinned);
    const moved = yield* notes.move(
      { from: saved.path, to: "moved.md", baseRevision: saved.revision },
      "agent",
    );
    assert.isTrue(moved.pinned);
    const unpinned = yield* notes.update({ path: moved.path, pinned: false });
    assert.isFalse(unpinned.pinned);
    assert.strictEqual(
      (yield* notes.update({ path: moved.path, pinned: false })).revision,
      unpinned.revision,
    );
  }).pipe(Effect.provide(layer())),
);

it.effect(
  "a note keeps its project through writes and moves, lists by project, and clears it",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const web = ProjectId.make("web");
      const scoped = yield* notes.write(
        { path: "a.md", body: "# A", baseRevision: null, project: web },
        "user",
      );
      yield* notes.write({ path: "b.md", body: "# B", baseRevision: null }, "user");
      assert.strictEqual(scoped.project, web);
      const saved = yield* notes.write(
        { path: "a.md", body: "# A2", baseRevision: scoped.revision },
        "user",
      );
      const moved = yield* notes.move(
        { from: "a.md", to: "m.md", baseRevision: saved.revision },
        "user",
      );
      assert.strictEqual(moved.project, web);
      assert.deepStrictEqual(
        (yield* notes.list({ project: web })).notes.map((note) => note.path),
        ["m.md"],
      );
      assert.strictEqual((yield* notes.list({})).notes.length, 2);
      const cleared = yield* notes.update({ path: "m.md", project: null });
      assert.isUndefined(cleared.project);
      assert.strictEqual((yield* notes.list({ project: web })).notes.length, 0);
    }).pipe(Effect.provide(layer())),
);

it.effect("relates only threads this environment has, idempotently", () => {
  const known = ThreadId.make("known");
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const initial = yield* notes.write({ path: "a.md", body: "keep", baseRevision: null }, "user");
    const missing = yield* notes
      .update({ path: initial.path, pinned: true, relate: ThreadId.make("missing") })
      .pipe(Effect.flip);
    assert.strictEqual(missing.reason, "not_found");
    assert.strictEqual((yield* notes.read({ path: initial.path })).revision, initial.revision);
    const related = yield* notes.update({ path: initial.path, relate: known });
    assert.deepStrictEqual(related.related, [known]);
    assert.strictEqual(
      (yield* notes.update({ path: initial.path, relate: known })).revision,
      related.revision,
    );
    const removed = yield* notes.update({ path: initial.path, unrelate: known });
    assert.deepStrictEqual(removed.related, []);
  }).pipe(
    Effect.provide(
      layer({
        getThread: (threadId) =>
          threadId === known
            ? Effect.succeed({
                id: threadId,
                deletedAt: null,
              } as unknown as OrchestrationV2AppThread)
            : Effect.fail(new Projections.ProjectionStoreThreadNotFoundError({ threadId })),
      }),
    ),
  );
});

it.effect("claims pending images to note-owned ids on save and releases them on delete", () => {
  const cleaned: Array<string> = [];
  return Effect.gen(function* () {
    const notes = yield* Notes.NotesService;
    const fs = yield* FileSystem.FileSystem;
    const { attachmentsDir } = yield* Config.ServerConfig;
    const pendingId = "pending-0b8e6a7e-1c1f-4c55-8d8e-0f6c0a1d2e3f";
    const foreignId = "card-1-6d7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f";
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFile(`${attachmentsDir}/${pendingId}.png`, new Uint8Array([1, 2, 3]));
    const note = yield* notes.write(
      {
        path: "shot.md",
        body: `# Shot\n![a](t3-attachment:${pendingId}) ![b](t3-attachment:${foreignId})\n`,
        baseRevision: null,
      },
      "user",
    );
    const claimedId = /t3-attachment:(note-[a-z0-9-]+)\)/.exec(note.body)![1]!;
    assert.isTrue(claimedId.startsWith(`note-${note.id}-`));
    assert.notInclude(note.body, pendingId);
    assert.include(note.body, foreignId);
    assert.strictEqual((yield* notes.read({ path: note.path })).body, note.body);
    assert.deepStrictEqual(
      Array.from(yield* fs.readFile(`${attachmentsDir}/${claimedId}.png`)),
      [1, 2, 3],
    );
    const missing = yield* notes
      .write(
        {
          path: note.path,
          body: "![c](t3-attachment:pending-7f2c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f)",
          baseRevision: note.revision,
        },
        "user",
      )
      .pipe(Effect.flip);
    assert.strictEqual(missing._tag === "NoteError" && missing.reason, "invalid");
    yield* notes.delete({ path: note.path, baseRevision: note.revision });
    assert.deepStrictEqual(cleaned, [claimedId]);
  }).pipe(Effect.provide(layer({ cleaned })));
});

it.effect(
  "a file that cannot be understood is listed as degraded, never dropped or rewritten",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      const duplicate = "---\na: 1\na: 2\n---\nHand edited\n";
      yield* fs.writeFileString(`${notesDir}/good.md`, "# Good\n");
      yield* fs.writeFileString(`${notesDir}/dup.md`, duplicate);
      yield* fs.writeFile(`${notesDir}/binary.md`, new Uint8Array([0x23, 0x20, 0xff, 0xfe]));
      yield* fs.makeDirectory(`${notesDir}/folder`);
      yield* fs.writeFileString(`${notesDir}/folder/ok.md`, "# Ok\n");
      yield* fs.writeFileString(`${notesDir}/UPPER.MD`, "# not a note name\n");
      yield* fs.writeFileString(`${notesDir}/legacy.markdown`, "# not a note name\n");
      yield* fs.writeFileString(`${notesDir}/cafe\u0301.md`, "# decomposed\n");
      yield* fs.writeFileString(`${notesDir}/a:b.md`, "# colon\n");
      yield* fs.writeFileString(`${notesDir}/readme.txt`, "ignored\n");

      const listed = yield* notes.list({});
      const byPath = new Map(listed.notes.map((note) => [note.path, note]));
      assert.deepStrictEqual([...byPath.keys()].toSorted(), [
        "binary.md",
        "dup.md",
        "folder/ok.md",
        "good.md",
      ]);
      assert.isUndefined(byPath.get("good.md")!.issue);
      assert.strictEqual(byPath.get("dup.md")!.issue, "invalid_frontmatter");
      assert.strictEqual(byPath.get("binary.md")!.issue, "invalid_utf8");
      assert.strictEqual(byPath.get("dup.md")!.title, "dup");
      assert.strictEqual(byPath.get("dup.md")!.size, duplicate.length);
      assert.deepStrictEqual(
        listed.skipped?.map((entry) => entry.name).toSorted(),
        ["UPPER.MD", "a:b.md", "cafe\u0301.md", "legacy.markdown"].toSorted(),
      );
      assert.isTrue(listed.skipped?.every((entry) => entry.reason === "unsupported_name"));
      assert.isFalse(listed.truncated);

      // The raw text is readable, and every edit is refused with the reason instead of rewriting it.
      const read = yield* notes.read({ path: "dup.md" });
      assert.strictEqual(read.body, duplicate);
      const refused = yield* notes
        .write({ path: "dup.md", baseRevision: read.revision, body: "x" }, "user")
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag === "NoteError" && refused.reason, "invalid");
      const pinned = yield* notes.update({ path: "dup.md", pinned: true }).pipe(Effect.flip);
      assert.strictEqual(pinned._tag === "NoteError" && pinned.reason, "invalid");
      assert.strictEqual(yield* fs.readFileString(`${notesDir}/dup.md`), duplicate);
      // It can still be removed.
      yield* notes.delete({ path: "dup.md", baseRevision: read.revision });
      assert.isFalse(yield* fs.exists(`${notesDir}/dup.md`));
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "an oversized file is listed as too_large and the rest of the list is cut with a count",
  () =>
    Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(`${notesDir}/huge.md`, "x".repeat(1024 * 1024 + 256 * 1024 + 1));
      const huge = (yield* notes.list({})).notes.find((note) => note.path === "huge.md");
      assert.strictEqual(huge?.issue, "too_large");
      const refused = yield* notes
        .delete({ path: "huge.md", baseRevision: huge!.revision })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag === "NoteError" && refused.reason, "too_large");
      for (let index = 0; index < 501; index++)
        yield* fs.writeFileString(`${notesDir}/n-${String(index).padStart(3, "0")}.md`, "# n\n");
      const listed = yield* notes.list({});
      assert.isTrue(listed.truncated);
      assert.strictEqual(listed.notes.length + (listed.omitted ?? 0), 502);
    }).pipe(Effect.provide(layer())),
);

it.effect(
  "the watcher publishes a note that became unreadable as degraded, not stale or removed",
  () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
      yield* Effect.gen(function* () {
        const notes = yield* Notes.NotesService;
        const fs = yield* FileSystem.FileSystem;
        const { notesDir } = yield* Config.ServerConfig;
        yield* fs.writeFileString(`${notesDir}/n.md`, "# Fine\n");
        const seen = yield* Queue.unbounded<NotesEvent>();
        yield* notes.subscribe.pipe(
          Stream.runForEach((event) => Queue.offer(seen, event)),
          Effect.forkScoped,
        );
        assert.equal((yield* Queue.take(seen)).type, "snapshot");
        yield* fs.writeFileString(`${notesDir}/n.md`, "---\na: 1\na: 2\n---\nBroken\n");
        yield* Queue.offer(changes, { _tag: "Update", path: "n.md" });
        yield* TestClock.adjust("100 millis");
        const event = yield* Queue.take(seen);
        assert.strictEqual(event.type === "upserted" && event.note.issue, "invalid_frontmatter");
        // A full resync reaches the same state as a single-path refresh.
        yield* Queue.offer(changes, { _tag: "Update", path: "other.txt" });
        yield* TestClock.adjust("100 millis");
        assert.strictEqual((yield* notes.list({})).notes[0]?.issue, "invalid_frontmatter");
      }).pipe(Effect.provide(queuedWatcher(changes)));
    }).pipe(Effect.scoped),
);

it.effect("a read that fails for a passing reason keeps the note and is retried", () =>
  Effect.gen(function* () {
    if (process.getuid?.() === 0) return;
    const changes = yield* Queue.unbounded<FileSystem.WatchEvent>();
    yield* Effect.gen(function* () {
      const notes = yield* Notes.NotesService;
      const fs = yield* FileSystem.FileSystem;
      const { notesDir } = yield* Config.ServerConfig;
      yield* fs.writeFileString(`${notesDir}/n.md`, "# One\n");
      const seen = yield* Queue.unbounded<NotesEvent>();
      yield* notes.subscribe.pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkScoped,
      );
      assert.equal((yield* Queue.take(seen)).type, "snapshot");
      yield* fs.writeFileString(`${notesDir}/n.md`, "# Two\n");
      yield* fs.chmod(`${notesDir}/n.md`, 0o000);
      yield* Queue.offer(changes, { _tag: "Update", path: "n.md" });
      yield* TestClock.adjust("100 millis");
      assert.strictEqual(yield* Queue.size(seen), 0);
      yield* fs.chmod(`${notesDir}/n.md`, 0o644);
      yield* TestClock.adjust("1 second");
      const event = yield* Queue.take(seen);
      assert.strictEqual(event.type === "upserted" && event.note.title, "Two");
    }).pipe(Effect.provide(queuedWatcher(changes)));
  }).pipe(Effect.scoped),
);
