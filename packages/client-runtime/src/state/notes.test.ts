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
