import { NotePath } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { moveToTitle, replaceNoteTitle, titleRenameTarget, type NoteMoveReply } from "./title.ts";
import type { NoteDocument } from "@t3tools/contracts";

const isNotePath = Schema.is(NotePath);

describe("replaceNoteTitle", () => {
  it.each([
    ["plain first line", "Old\nbody", "New", "New\nbody"],
    ["h1", "# Old\nbody", "New", "# New\nbody"],
    ["h3 keeps its level", "### Old ###\nbody", "New", "### New\nbody"],
    ["empty body", "", "New", "# New"],
    ["blank body", "\n\n", "New", "# New\n\n\n"],
    ["leading blank lines", "\n\nOld\nbody", "New", "\n\nNew\nbody"],
    ["CRLF", "# Old\r\nbody\r\n", "New", "# New\r\nbody\r\n"],
    ["CRLF plain", "Old\r\nbody", "New", "New\r\nbody"],
    ["a later heading is the title", "intro\n## Old\nbody", "New", "intro\n## New\nbody"],
    ["list marker kept", "- Old\nmore", "New", "- New\nmore"],
    ["task marker kept", "- [ ] Old", "New", "- [ ] New"],
    ["quote marker kept", "> Old", "New", "> New"],
    ["whitespace collapsed", "# Old", "  a \n b  ", "# a b"],
    ["hash without space is plain", "#tag\nx", "New", "New\nx"],
  ] as const)("%s", (_name, body, title, expected) => {
    expect(replaceNoteTitle(body, title)).toBe(expected);
  });
});

describe("titleRenameTarget", () => {
  it.each([
    ["Untitled.md", "", "Plan", 0, "Plan.md"],
    ["Untitled 7.md", "", "Plan", 0, "Plan.md"],
    ["Untitled.md", "", "Plan", 2, "Plan 3.md"],
    ["project/Untitled 2.md", "", "Plan", 0, "project/Plan.md"],
    ["Untitled.md", "", "  a/b: c\\d  ", 0, "a b c d.md"],
    ["Untitled.md", "", "..hidden.", 0, "hidden.md"],
    ["Untitled.md", "", "x".repeat(200), 0, `${"x".repeat(80)}.md`],
    ["Untitled.md", "", `${"x".repeat(79)}\u{1F600}`, 0, `${"x".repeat(79)}.md`],
    ["Untitled.md", "", "", 0, null],
    ["Untitled.md", "", "Untitled 3", 0, null],
    ["Untitled.md", "", " / : ", 0, null],
    ["Plan.md", "Plan", "Roadmap", 0, "Roadmap.md"],
    ["Plan.md", "Plan", "Roadmap", 1, "Roadmap 2.md"],
    ["work/Plan.md", "Plan", "Roadmap", 0, "work/Roadmap.md"],
    ["Plan 2.md", "Plan", "Roadmap", 0, "Roadmap.md"],
    ["Plan.md", "Plan", "Plan!", 0, "Plan!.md"],
    ["Plan.md", "Plan", "Plan", 0, null],
    ["Plan.md", "Plan", "Untitled", 0, null],
    ["Plan.md", "Plan", "", 0, null],
    ["mine.md", "Plan", "Roadmap", 0, null],
    ["Plan notes.md", "Plan", "Roadmap", 0, null],
    ["Plan.md", "", "Roadmap", 0, null],
    ["a+b.md", "a+b", "c", 0, "c.md"],
  ] as const)(
    "%s (was %j) titled %j attempt %i -> %j",
    (path, previous, next, attempt, expected) => {
      const target = titleRenameTarget(path, previous, next, attempt);
      expect(target).toBe(expected);
      if (target !== null) expect(isNotePath(target)).toBe(true);
    },
  );
});

describe("moveToTitle", () => {
  const moved = { path: "Roadmap 2.md" } as NoteDocument;
  const note = { path: "Plan.md", revision: "r" };
  it("steps past taken names and returns the moved note", async () => {
    const move = vi
      .fn<(input: { from: string; to: string; baseRevision: string }) => Promise<NoteMoveReply>>()
      .mockResolvedValueOnce({ ok: false, error: { reason: "exists" } })
      .mockResolvedValueOnce({ ok: true, value: moved });
    expect(await moveToTitle(move, note, "Plan", "Roadmap")).toBe(moved);
    expect(move.mock.calls.map(([input]) => input.to)).toEqual(["Roadmap.md", "Roadmap 2.md"]);
  });
  it.each([
    ["a hand-named file", "mine.md", { ok: true, value: moved }],
    ["a failure other than a taken name", "Plan.md", { ok: false, error: new Error("x") }],
    ["a failure with no reason", "Plan.md", { ok: false, error: null }],
  ] as const)("returns null for %s", async (_name, path, reply) => {
    const move = vi.fn().mockResolvedValue(reply);
    expect(await moveToTitle(move, { path, revision: "r" }, "Plan", "Roadmap")).toBeNull();
    expect(move).toHaveBeenCalledTimes(path === "mine.md" ? 0 : 1);
  });
  it("gives up after five taken names", async () => {
    const move = vi.fn().mockResolvedValue({ ok: false, error: { reason: "exists" } });
    expect(await moveToTitle(move, note, "Plan", "Roadmap")).toBeNull();
    expect(move).toHaveBeenCalledTimes(5);
  });
});
