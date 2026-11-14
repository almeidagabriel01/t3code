import { describe, expect, it } from "vite-plus/test";

import { assistantRunReply, briefReply } from "./assistantRunReply.ts";

const longReport = [
  "Upload retry is done: [Add upload retry](t3-thread://v1/task-1).",
  "",
  "## Commits",
  "- a1b2c3d feat(upload): retry with exponential backoff",
  "- d4e5f6a test(upload): cover retry",
  "",
  "| Check | Result |",
  "| --- | --- |",
  "| tests | 12 passed |",
].join("\n");

describe("assistantRunReply", () => {
  it.each([
    { origin: "assistant", text: "NO_REPLY", expected: undefined },
    { origin: "other", text: "`NO_REPLY`.", expected: undefined },
    // Text before the token still tells the user something: only the token is dropped.
    {
      origin: "other",
      text: "Tarefa X falhou no CI.\n\nNO_REPLY",
      expected: "Tarefa X falhou no CI.",
    },
    { origin: "group", text: "NO_REPLY", expected: undefined },
    { origin: "assistant", text: "  ", expected: undefined },
    { origin: "assistant", text: undefined, expected: undefined },
    // The user's own question always gets its whole answer, even a literal token.
    { origin: "user", text: "NO_REPLY", expected: "NO_REPLY" },
    { origin: "user", text: longReport, expected: longReport },
    { origin: "routine", text: longReport, expected: longReport },
  ] as const)("$origin: $text", ({ origin, text, expected }) => {
    expect(assistantRunReply(text, origin)).toBe(expected);
  });

  it("an event turn sends the short version, never its tables", () => {
    const sent = assistantRunReply(longReport, "assistant");
    expect(sent).toBe(
      [
        "Upload retry is done: [Add upload retry](t3-thread://v1/task-1).",
        "",
        "## Commits",
        "- a1b2c3d feat(upload): retry with exponential backoff",
        "- d4e5f6a test(upload): cover retry",
        "…",
      ].join("\n"),
    );
  });
});

describe("briefReply", () => {
  it("keeps a short reply whole", () => {
    expect(briefReply("  Task done, tests pass.\n")).toBe("Task done, tests pass.");
  });

  it("stops at eight lines", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
    expect(briefReply(text).split("\n")).toHaveLength(9);
    expect(briefReply(text).endsWith("line 7\n…")).toBe(true);
  });

  it("cuts one overlong line at a word", () => {
    const sent = briefReply("word ".repeat(300));
    expect(sent.length).toBeLessThanOrEqual(601);
    expect(sent.endsWith("word…")).toBe(true);
  });

  it.each([
    ["bold", `Done: **${"very ".repeat(150)}important**`],
    ["a link", `Done, see [${"the ".repeat(150)}report](t3-thread://v1/task-1)`],
  ])("cuts an overlong block as plain text, never leaving %s open", (_name, text) => {
    const sent = briefReply(text);
    expect(sent.length).toBeLessThanOrEqual(601);
    expect(sent).not.toMatch(/\*\*|\[|\]\(/);
  });

  it("drops whole list items that do not fit", () => {
    const items = Array.from({ length: 12 }, (_, index) => `- item ${index}`).join("\n");
    expect(briefReply(`Done:\n\n${items}`)).toBe(
      `Done:\n\n${items.split("\n").slice(0, 6).join("\n")}\n…`,
    );
  });

  it.each([
    ["a trailing code block", "Fixed it.\n```ts\nconst a = 1;\n```", "Fixed it.\n…"],
    ["a leading code block", "```ts\nconst a = 1;\n```\nFixed it.", "Fixed it.\n…"],
    ["a leading table", "| Check | Result |\n| --- | --- |\n\nAll green.", "All green.\n…"],
    [
      "a table without outer pipes",
      "All green.\n\nCheck | Result\n--|--\ntests | 12",
      "All green.\n…",
    ],
    ["nothing but a table", "| Check | Result |\n| --- | --- |", "…"],
  ])("leaves out %s", (_name, text, expected) => {
    expect(briefReply(text)).toBe(expected);
  });
});
