import { describe, expect, it } from "@effect/vitest";

import {
  canEditNoteDraft,
  newNotePath,
  noteListRows,
  noteSyncLabel,
  noteSyncState,
} from "./notes-model";
import { document, row } from "./test-fixtures";

describe("notes list", () => {
  it("overlays offline notes only for their owning environment", () => {
    const rows = noteListRows(
      "hub",
      [document()],
      [
        row(),
        {
          ...row(),
          path: "project/idea.md",
          body: "# Draft",
          state: "conflict",
          current: document(),
        },
        { ...row(), environmentId: "another", path: "hidden.md" },
      ],
    );
    expect(rows.map((entry) => [entry.path, entry.title, entry.sync, entry.group])).toEqual([
      ["note.md", "Note", "pending", "Notes"],
      ["project/idea.md", "Draft", "conflict", "project"],
    ]);
  });

  it("lists pinned notes first, then loose notes, then each folder most recently updated first", () => {
    const note = (path: string, updatedAt: string, pinned = false) => ({
      ...document(),
      path,
      folder: path.includes("/") ? path.split("/")[0]! : null,
      title: path,
      updatedAt,
      pinned,
    });
    const rows = noteListRows(
      "hub",
      [
        note("b/old.md", "2026-10-01T00:00:00.000Z"),
        note("b/new.md", "2026-10-20T00:00:00.000Z"),
        note("a/one.md", "2026-10-02T00:00:00.000Z"),
        note("loose.md", "2026-09-02T00:00:00.000Z"),
        note("z/pinned.md", "2026-09-01T00:00:00.000Z", true),
      ],
      [],
    );
    expect(rows.map((entry) => [entry.group, entry.path])).toEqual([
      ["Pinned", "z/pinned.md"],
      ["Notes", "loose.md"],
      ["a", "a/one.md"],
      ["b", "b/new.md"],
      ["b", "b/old.md"],
    ]);
  });

  it("keeps a pinned note pinned while its draft is pending", () => {
    const rows = noteListRows("hub", [{ ...document(), pinned: true }], [row()]);
    expect(rows[0]).toMatchObject({ pinned: true, group: "Pinned", sync: "pending" });
  });

  it("adds the markdown extension to a typed note name only when missing", () => {
    expect(newNotePath(" ideas ")).toBe("ideas.md");
    expect(newNotePath("project/plan.md")).toBe("project/plan.md");
  });
});

it("permits local drafts offline while connected read-only access stays read-only", () => {
  expect(canEditNoteDraft(false, false, true)).toBe(true);
  expect(canEditNoteDraft(false, true, true)).toBe(false);
  expect(canEditNoteDraft(false, false, false)).toBe(false);
  expect(canEditNoteDraft(true, true, true)).toBe(true);
});

describe("note sync presentation", () => {
  it("distinguishes saved, sending, conflicted and acknowledged edits", () => {
    const pending = row();
    const sending = { ...pending, inFlight: pending };
    const conflict = { ...sending, state: "conflict" as const };
    expect(noteSyncLabel(noteSyncState(pending))).toBe(
      "Saved on this device · syncs when connected",
    );
    expect(noteSyncLabel(noteSyncState(sending))).toBe("Syncing…");
    expect(noteSyncLabel(noteSyncState(conflict))).toBe("Needs your choice");
    expect(noteSyncLabel(noteSyncState())).toBeNull();
    expect(noteListRows("hub", [document()], [sending])[0]?.sync).toBe("syncing");
    expect(noteListRows("hub", [document()], [conflict])[0]?.sync).toBe("conflict");
    expect(noteListRows("hub", [document()], [])[0]?.sync).toBe("synced");
  });
});
