import { assert, describe, it } from "@effect/vitest";
import type { NoteSummary, NotesEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { applyNotesEvent, notesStateStream, selectNotesInOrder } from "./notes.ts";

const note = (path: string, overrides: Partial<NoteSummary> = {}): NoteSummary =>
  ({
    id: null,
    path,
    folder: path.includes("/") ? path.split("/")[0]! : null,
    title: path,
    pinned: false,
    preview: "",
    related: [],
    card: null,
    updatedBy: null,
    revision: "a".repeat(64),
    updatedAt: "2026-10-01T00:00:00.000Z",
    size: 0,
    ...overrides,
  }) as NoteSummary;

const snapshot: NotesEvent = {
  type: "snapshot",
  notes: [note("a.md"), note("work/b.md")],
  folders: ["work"],
  truncated: false,
};

describe("notes state", () => {
  it("ignores changes before the snapshot and folds upserts and removals after it", () => {
    assert.isNull(applyNotesEvent(null, { type: "upserted", note: note("a.md") }));
    const initial = applyNotesEvent(null, snapshot)!;
    const upserted = applyNotesEvent(initial, {
      type: "upserted",
      note: note("ideas/c.md", { title: "C" }),
    })!;
    assert.deepStrictEqual(upserted.folders, ["ideas", "work"]);
    assert.strictEqual(upserted.notes.get("ideas/c.md")?.title, "C");
    assert.strictEqual(initial.notes.size, 2);
    const removed = applyNotesEvent(upserted, { type: "removed", path: "a.md" })!;
    assert.deepStrictEqual([...removed.notes.keys()], ["work/b.md", "ideas/c.md"]);
    assert.strictEqual(applyNotesEvent(removed, snapshot)!.notes.size, 2);
    // The server's counts and unlisted files reach the state, and default when it sends none.
    assert.strictEqual(initial.omitted, 0);
    assert.deepStrictEqual(initial.skipped, []);
    const cut = applyNotesEvent(null, {
      ...snapshot,
      truncated: true,
      omitted: 3,
      skipped: [{ name: "x.MD", reason: "unsupported_name" }],
    })!;
    assert.strictEqual(cut.omitted, 3);
    assert.strictEqual(cut.skipped[0]?.name, "x.MD");
    // Live events carry the current omitted count, even for a path the client never held.
    const grown = applyNotesEvent(cut, { type: "removed", path: "zzz.md", omitted: 4 })!;
    assert.deepStrictEqual([grown.omitted, grown.truncated], [4, true]);
    const shrunk = applyNotesEvent(grown, { type: "upserted", note: note("b.md"), omitted: 0 })!;
    assert.deepStrictEqual([shrunk.omitted, shrunk.truncated], [0, false]);
  });

  it("orders pinned notes first, then the most recently updated", () => {
    const state = applyNotesEvent(null, {
      ...snapshot,
      notes: [
        note("old.md", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        note("new.md", { updatedAt: "2026-09-01T00:00:00.000Z" }),
        note("pinned.md", { pinned: true, updatedAt: "2025-01-01T00:00:00.000Z" }),
      ],
    })!;
    assert.deepStrictEqual(
      selectNotesInOrder(state).map((entry) => entry.path),
      ["pinned.md", "new.md", "old.md"],
    );
  });

  it("breaks ties by path and re-upserting a note replaces it instead of duplicating", () => {
    const state = applyNotesEvent(null, {
      ...snapshot,
      notes: [note("b.md"), note("a.md"), note("c.md", { pinned: true })],
    })!;
    assert.deepStrictEqual(
      selectNotesInOrder(state).map((entry) => entry.path),
      ["c.md", "a.md", "b.md"],
    );
    const again = applyNotesEvent(state, {
      type: "upserted",
      note: note("a.md", { pinned: true }),
    })!;
    assert.strictEqual(again.notes.size, 3);
    assert.deepStrictEqual(
      selectNotesInOrder(again).map((entry) => entry.path),
      ["a.md", "c.md", "b.md"],
    );
  });

  it.effect("emits a state for the snapshot and every change", () =>
    Effect.gen(function* () {
      const states = yield* notesStateStream(
        Stream.make(snapshot, { type: "removed", path: "a.md" } as const),
      ).pipe(Stream.runCollect);
      assert.deepStrictEqual(
        states.map((state) => state.notes.size),
        [2, 1],
      );
    }),
  );
});
