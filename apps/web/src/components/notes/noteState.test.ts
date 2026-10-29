import { NoteConflictError, type NoteDocument, type NotesWriteInput } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  claimedImageIds,
  filterNotes,
  groupNotes,
  isNoteDirty,
  NoteSession,
  untitledNotePath,
  type NoteReply,
} from "./noteState";

const document = (body = "Original", revision = "a".repeat(64)): NoteDocument => ({
  id: null,
  path: "project/idea.md",
  folder: "project",
  title: "Idea",
  body,
  pinned: false,
  preview: "",
  related: [],
  card: null,
  updatedBy: "user",
  revision,
  updatedAt: "2026-10-19T00:00:00.000Z",
  size: body.length,
});
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("note edit session", () => {
  it("keeps edits made during a save and advances their base revision", async () => {
    const response = deferred<NoteReply<NoteDocument>>();
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(response.promise)
      .mockImplementation(async (input) => ({
        ok: true,
        value: document(input.body, "c".repeat(64)),
      }));
    const session = new NoteSession(document(), write);
    session.edit("First edit");
    const saving = session.save();
    session.edit("Second edit");
    await session.save();
    expect(write).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, value: document("First edit", "b".repeat(64)) });
    await saving;
    expect(session.getSnapshot().body).toBe("Second edit");
    expect(isNoteDirty(session.getSnapshot())).toBe(true);
    await session.save();
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      baseRevision: "b".repeat(64),
      body: "Second edit",
    });
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("keeps an incoming external edit separate and pauses saving until compare", async () => {
    const write = vi.fn();
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    session.receive(document("Theirs", "b".repeat(64)));
    await session.save();
    expect(write).not.toHaveBeenCalled();
    expect(session.getSnapshot().body).toBe("Mine");
    session.acceptTheirs();
    expect(session.getSnapshot().body).toBe("Theirs");
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
    expect(session.getSnapshot().editorVersion).toBe(1);
  });
  it("uses the conflict revision for Keep mine and compares again on a second conflict", async () => {
    const theirs = document("Theirs", "b".repeat(64));
    const newer = document("Changed again", "c".repeat(64));
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({ path: theirs.path, current: theirs, message: "Changed" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({
          path: newer.path,
          current: newer,
          message: "Changed again",
        }),
      });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(session.getSnapshot().incoming).toEqual(theirs);
    await session.keepMine();
    expect(write.mock.calls[1]?.[0]).toMatchObject({ baseRevision: theirs.revision, body: "Mine" });
    expect(session.getSnapshot().incoming).toEqual(newer);
    expect(session.getSnapshot().body).toBe("Mine");
  });
  it("refreshes a clean editor and updates metadata without resetting selection for the same revision", () => {
    const session = new NoteSession(document(), vi.fn());
    session.receive(document("Agent change", "b".repeat(64)));
    expect(session.getSnapshot().body).toBe("Agent change");
    expect(session.getSnapshot().editorVersion).toBe(1);
    session.receive({ ...document("Agent change", "b".repeat(64)), title: "Renamed" });
    expect(session.getSnapshot().editorVersion).toBe(1);
    expect(session.getSnapshot().document.title).toBe("Renamed");
  });
  it("does not mistake its own streamed write for an unresolved conflict", async () => {
    const result = deferred<NoteReply<NoteDocument>>();
    const session = new NoteSession(document(), () => result.promise);
    session.edit("Mine");
    const saving = session.save();
    const saved = document("Mine", "b".repeat(64));
    session.receive(saved);
    result.resolve({ ok: true, value: saved });
    await saving;
    expect(session.getSnapshot().incoming).toBe(null);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("ignores a read begun before a save acknowledgement without rejecting a later exact revert", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "b".repeat(64));
    const session = new NoteSession(document(), async () => ({ ok: true, value: saved }));
    const read = vi
      .fn<() => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce({ ok: true, value: saved });
    const refreshing = session.refresh(read);
    session.edit("Mine");
    await session.save();
    reply.resolve({ ok: true, value: document() });
    await refreshing;
    expect(session.getSnapshot().body).toBe("Mine");
    await session.refresh(async () => ({ ok: true, value: document() }));
    expect(session.getSnapshot().body).toBe("Original");
  });
  it("re-reads an external update whose response crossed a save acknowledgement", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const external = document("External after save", "c".repeat(64));
    const saved = document("Mine", "b".repeat(64));
    const session = new NoteSession(document(), async () => ({ ok: true, value: saved }));
    session.edit("Mine");
    const read = vi
      .fn<() => Promise<NoteReply<NoteDocument>>>()
      .mockReturnValueOnce(reply.promise)
      .mockResolvedValueOnce({ ok: true, value: external });
    const refreshing = session.refresh(read);
    await session.save();
    reply.resolve({ ok: true, value: external });
    await refreshing;
    expect(read).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().body).toBe(external.body);
  });
  it("ignores out-of-order external reads", async () => {
    const older = deferred<NoteReply<NoteDocument>>();
    const session = new NoteSession(document(), vi.fn());
    const first = session.refresh(() => older.promise);
    await session.refresh(async () => ({ ok: true, value: document("Newest", "c".repeat(64)) }));
    older.resolve({ ok: true, value: document("Older", "b".repeat(64)) });
    await first;
    expect(session.getSnapshot().body).toBe("Newest");
  });
  it("does not send an autosave scheduled for an obsolete draft", async () => {
    const send = vi.fn();
    const session = new NoteSession(document(), send);
    session.edit("First");
    session.edit("Second");
    await session.save("First");
    expect(send).not.toHaveBeenCalled();
  });
  it("lets a stale rename or delete compare the current file before discarding the old body", () => {
    const session = new NoteSession(document(), vi.fn());
    session.compare(document("Changed before rename", "b".repeat(64)));
    expect(session.getSnapshot().body).toBe("Original");
    expect(session.getSnapshot().incoming?.body).toBe("Changed before rename");
    session.acceptTheirs();
    expect(session.getSnapshot().body).toBe("Changed before rename");
  });
  it("moves a draft onto a pin or link change without asking to compare", () => {
    const session = new NoteSession(document(), vi.fn());
    session.edit("Mine");
    session.receive({ ...document("Original", "b".repeat(64)), pinned: true });
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe("b".repeat(64));
    expect(session.getSnapshot().body).toBe("Mine");
  });
  it("rereads after a save when a pin made before the save arrives first", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "c".repeat(64));
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({ ok: true, value: saved }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive({ ...document("Original", "b".repeat(64)), pinned: true });
    reply.resolve({ ok: true, value: saved });
    await saving;
    expect(read).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe(saved.revision);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("adopts a pin made after the save without prompting and keeps later typing", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const saved = document("Mine", "c".repeat(64));
    const pinnedAfter = { ...document("Mine", "d".repeat(64)), pinned: true };
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({
      ok: true,
      value: pinnedAfter,
    }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive(pinnedAfter);
    session.edit("Mine, then more");
    reply.resolve({ ok: true, value: saved });
    await saving;
    expect(session.getSnapshot().incoming).toBe(null);
    expect(session.getSnapshot().document.revision).toBe(pinnedAfter.revision);
    expect(session.getSnapshot().body).toBe("Mine, then more");
  });
  it("still asks to compare when another writer changed the body during the save", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const theirs = document("Theirs", "d".repeat(64));
    const read = vi.fn(async (): Promise<NoteReply<NoteDocument>> => ({ ok: true, value: theirs }));
    const session = new NoteSession(document(), () => reply.promise, read);
    session.edit("Mine");
    const saving = session.save();
    session.receive(theirs);
    session.edit("Mine again");
    reply.resolve({ ok: true, value: document("Mine", "c".repeat(64)) });
    await saving;
    expect(session.getSnapshot().incoming).toEqual(theirs);
    expect(session.getSnapshot().body).toBe("Mine again");
  });
  it("retries once on a conflict caused only by a header change", async () => {
    const pinned = { ...document("Original", "b".repeat(64)), pinned: true };
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockResolvedValueOnce({
        ok: false,
        error: new NoteConflictError({ path: pinned.path, current: pinned, message: "Changed" }),
      })
      .mockResolvedValueOnce({ ok: true, value: document("Mine", "c".repeat(64)) });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(write.mock.calls[1]?.[0].baseRevision).toBe(pinned.revision);
    expect(session.getSnapshot().incoming).toBe(null);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
  it("preserves the draft on transport failure and retries with the original revision", async () => {
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce({ ok: true, value: document("Mine", "b".repeat(64)) });
    const session = new NoteSession(document(), write);
    session.edit("Mine");
    await session.save();
    expect(session.getSnapshot().error).toBe("Disconnected");
    expect(session.getSnapshot().body).toBe("Mine");
    await session.save();
    expect(write.mock.calls[1]?.[0].baseRevision).toBe(document().revision);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
  });
});

describe("uploaded images in a saved note", () => {
  const pendingRef = "![shot.png](t3-attachment:pending-11111111-1111-4111-8111-111111111111)";
  const claimedRef = "![shot.png](t3-attachment:note-abc-22222222-2222-4222-8222-222222222222)";

  it("pairs upload ids with the ids the server stored them under", () => {
    expect(claimedImageIds(`A\n\n${pendingRef}\n`, `A\n\n${claimedRef}\n`)).toEqual(
      new Map([
        [
          "pending-11111111-1111-4111-8111-111111111111",
          "note-abc-22222222-2222-4222-8222-222222222222",
        ],
      ]),
    );
    expect(claimedImageIds(`A\n${pendingRef}`, `B\n${claimedRef}`)).toBe(null);
  });

  it("takes the stored ids into the draft so the next save does not upload again", async () => {
    const write = vi
      .fn<(input: NotesWriteInput) => Promise<NoteReply<NoteDocument>>>()
      .mockImplementation(async (input) => ({
        ok: true,
        value: document(input.body.replace(pendingRef, claimedRef), "b".repeat(64)),
      }));
    const session = new NoteSession(document(), write);
    session.edit(`Original\n\n${pendingRef}\n`);
    await session.save();
    const state = session.getSnapshot();
    expect(state.body).toBe(`Original\n\n${claimedRef}\n`);
    expect(isNoteDirty(state)).toBe(false);
    expect(state.editorVersion).toBe(0);
    // An editor that still shows the upload id reports the stored one.
    session.edit(`Original\n\n${pendingRef}\n`);
    expect(isNoteDirty(session.getSnapshot())).toBe(false);
    await session.save();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("keeps typing made while the image saved, with the stored id", async () => {
    const reply = deferred<NoteReply<NoteDocument>>();
    const session = new NoteSession(document(), () => reply.promise);
    session.edit(`Original\n\n${pendingRef}\n`);
    const saving = session.save();
    session.edit(`Original\n\n${pendingRef}\n\nMore`);
    reply.resolve({ ok: true, value: document(`Original\n\n${claimedRef}\n`, "b".repeat(64)) });
    await saving;
    expect(session.getSnapshot().body).toBe(`Original\n\n${claimedRef}\n\nMore`);
  });
});

describe("note list", () => {
  const summary = (path: string, updatedAt: string, pinned = false) => {
    const folder = path.includes("/") ? path.slice(0, path.indexOf("/")) : null;
    return { ...document(), path, folder, title: path, pinned, updatedAt };
  };

  it("puts pinned notes first, then loose notes, then folders, each most recent first", () => {
    const groups = groupNotes(
      [
        summary("b/old.md", "2026-01-01T00:00:00.000Z"),
        summary("loose.md", "2026-01-02T00:00:00.000Z"),
        summary("b/new.md", "2026-01-03T00:00:00.000Z"),
        summary("a/pinned.md", "2026-01-01T00:00:00.000Z", true),
      ],
      ["a", "b", "empty"],
    );
    expect(groups.pinned.map((note) => note.path)).toEqual(["a/pinned.md"]);
    expect(groups.loose.map((note) => note.path)).toEqual(["loose.md"]);
    expect(groups.folders.map((group) => [group.folder, group.notes.map((n) => n.path)])).toEqual([
      ["a", []],
      ["b", ["b/new.md", "b/old.md"]],
      ["empty", []],
    ]);
  });

  it("matches every search term against the title, preview, or path", () => {
    const notes = [
      { ...summary("plans/launch.md", "2026-01-01T00:00:00.000Z"), preview: "ship the beta" },
      summary("ideas.md", "2026-01-01T00:00:00.000Z"),
    ];
    expect(filterNotes(notes, "plans beta").map((note) => note.path)).toEqual(["plans/launch.md"]);
    expect(filterNotes(notes, "  ")).toBe(notes);
  });

  it("names a new note after the first free Untitled slot", () => {
    const taken = new Set(["Untitled.md", "work/Untitled.md", "work/Untitled 2.md"]);
    expect(untitledNotePath(taken, null)).toBe("Untitled 2.md");
    expect(untitledNotePath(taken, "work")).toBe("work/Untitled 3.md");
    expect(untitledNotePath(taken, "work", 1)).toBe("work/Untitled 4.md");
  });
});
