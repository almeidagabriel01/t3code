import { describe, expect, it } from "@effect/vitest";
import { diffNoteLines } from "./line-diff.ts";

describe("note line diff", () => {
  it("handles empty versions, additions and removals", () => {
    expect(diffNoteLines("", "")).toEqual({ local: [], server: [], wholeBlock: false });
    expect(diffNoteLines("new", "").local).toEqual([{ text: "new", kind: "added" }]);
    expect(diffNoteLines("", "old").server).toEqual([{ text: "old", kind: "removed" }]);
  });

  it("preserves blank lines, trailing newlines, whitespace, CRLF and Unicode", () => {
    const body = "# 메모 🐐\r\n\n  task\t\n";
    const diff = diffNoteLines(body, body);
    expect(diff.local.map((line) => line.text).join("\n")).toBe(body);
    expect(diff.local.every((line) => line.kind === "unchanged")).toBe(true);
    expect(diff.server).toEqual(diff.local);
    expect(diffNoteLines("task ", "task").local[0]?.kind).toBe("added");
    expect(diffNoteLines("task\n", "task").local.at(-1)).toEqual({ text: "", kind: "added" });
  });

  it("aligns repeated lines using the longest common subsequence", () => {
    const diff = diffNoteLines("A\nB\nA\nC", "A\nA\nB\nC");
    expect(diff.local.filter((line) => line.kind === "unchanged").map((line) => line.text)).toEqual(
      ["A", "A", "C"],
    );
    expect(
      diff.server.filter((line) => line.kind === "unchanged").map((line) => line.text),
    ).toEqual(["A", "A", "C"]);
    expect(diff.local.filter((line) => line.kind === "added")).toEqual([
      { text: "B", kind: "added" },
    ]);
    expect(diff.server.filter((line) => line.kind === "removed")).toEqual([
      { text: "B", kind: "removed" },
    ]);
  });

  it.each([
    ["matrix budget", Array(500).fill("local").join("\n"), Array(500).fill("server").join("\n")],
    ["line budget", "local\n".repeat(2001), "server"],
    ["character budget", "x".repeat(128001), "server"],
  ])("falls back to complete blocks at the %s", (_, local, server) => {
    expect(diffNoteLines(local, server)).toEqual({
      local: [{ text: local, kind: "added" }],
      server: [{ text: server, kind: "removed" }],
      wholeBlock: true,
    });
  });

  it("does not highlight identical oversized blocks as changed", () => {
    const body = "same\n".repeat(2001);
    const diff = diffNoteLines(body, body);
    expect(diff.wholeBlock).toBe(true);
    expect(diff.local).toEqual([{ text: body, kind: "unchanged" }]);
    expect(diff.server).toEqual(diff.local);
  });

  it("highlights replacements while leaving shared context intact", () => {
    const diff = diffNoteLines("# Note\n- [x] task\nend", "# Note\n- [ ] task\nend");
    expect(diff.local).toEqual([
      { text: "# Note", kind: "unchanged" },
      { text: "- [x] task", kind: "added" },
      { text: "end", kind: "unchanged" },
    ]);
    expect(diff.server).toEqual([
      { text: "# Note", kind: "unchanged" },
      { text: "- [ ] task", kind: "removed" },
      { text: "end", kind: "unchanged" },
    ]);
  });
});
