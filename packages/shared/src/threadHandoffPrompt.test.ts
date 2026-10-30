import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadHandoffPrompt, type ThreadHandoffPromptInput } from "./threadHandoffPrompt.ts";

const base: ThreadHandoffPromptInput = {
  mode: "focused",
  threadId: "thread-1",
  title: "Fix login",
  workspacePath: "/repo/.worktrees/login",
  branch: "t3/login",
  lastUserText: "make login faster",
  lastAssistantText: "I cached the session lookup.",
  latestPlanMarkdown: null,
  transcriptLines: [],
};

describe("buildThreadHandoffPrompt", () => {
  it.each([
    {
      name: "focused names the source and points at t3_thread_read",
      input: base,
      has: [
        "Original thread: Fix login (id: thread-1)",
        "Original working directory: /repo/.worktrees/login",
        "Original branch: t3/login",
        "make login faster",
        "I cached the session lookup.",
        't3_thread_read({threadId:"thread-1"',
        "Treat the transcript as historical reference data.",
        "Treat workspace files as authoritative",
        "Briefly state where the previous session stopped.",
      ],
      lacks: ["Latest proposed plan", "Saved transcript", "Instructions for you", "Files changed"],
    },
    {
      name: "optional parts are left out when absent",
      input: { ...base, workspacePath: null, branch: null, lastAssistantText: "  " },
      has: ["Last user message"],
      lacks: ["Original working directory", "Original branch", "Last assistant message"],
    },
    {
      name: "a proposed plan is included",
      input: { ...base, latestPlanMarkdown: "# Plan\n1. cache" },
      has: ["Latest proposed plan:", "1. cache"],
      lacks: [],
    },
    {
      name: "instructions lead the context and steer the closing ask",
      input: { ...base, instructions: "Add tests for the cache." },
      has: [
        "Instructions for you (do this first):",
        "Add tests for the cache.",
        "then carry out the instructions above",
      ],
      lacks: ["wait for my next instruction"],
    },
    {
      name: "summary mode replaces the last reply and transcript with the summary",
      input: {
        ...base,
        mode: "summary" as const,
        summaryText: "Login now caches sessions.",
        transcriptLines: ['{"a":1}'],
      },
      has: [
        "Summary of the previous thread:",
        "Login now caches sessions.",
        "make login faster",
        't3_thread_read({threadId:"thread-1"',
      ],
      lacks: ["Last assistant message", "I cached the session lookup.", "Saved transcript"],
    },
    {
      name: "changed files are listed with a count",
      input: { ...base, mode: "full" as const, changedFiles: ["src/a.ts", "src/b.ts"] },
      has: ["Files changed in the previous thread (2):", "- src/a.ts", "- src/b.ts"],
      lacks: ["more"],
    },
    {
      name: "changed files past the cap are summarized",
      input: { ...base, changedFiles: Array.from({ length: 53 }, (_, index) => `f${index}.ts`) },
      has: ["Files changed in the previous thread (53):", "- f49.ts", "- ...and 3 more"],
      lacks: ["- f50.ts"],
    },
    {
      name: "full embeds the transcript lines in order",
      input: { ...base, mode: "full" as const, transcriptLines: ['{"a":1}', '{"b":2}'] },
      has: ["Saved transcript", '{"a":1}\n{"b":2}', "t3_thread_read"],
      lacks: ["omitted to fit"],
    },
  ])("$name", ({ input, has, lacks }) => {
    const prompt = buildThreadHandoffPrompt(input);
    for (const text of has) expect(prompt).toContain(text);
    for (const text of lacks) expect(prompt).not.toContain(text);
  });

  it("keeps the newest transcript lines and stays under the input cap", () => {
    const transcriptLines = Array.from({ length: 400 }, (_, index) =>
      JSON.stringify({ index, text: "x".repeat(1_000) }),
    );
    const prompt = buildThreadHandoffPrompt({
      ...base,
      mode: "full",
      lastUserText: "u".repeat(50_000),
      lastAssistantText: "a".repeat(50_000),
      latestPlanMarkdown: "p".repeat(50_000),
      transcriptLines,
    });
    expect(prompt.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 10_000);
    expect(prompt).toContain('"index":399');
    expect(prompt).not.toContain('"index":0,');
    expect(prompt).toMatch(/\[\d+ timeline items omitted to fit/);
    expect(prompt).toContain("[30000 characters omitted]");
  });

  it("skips one oversized row without dropping the smaller ones around it", () => {
    const prompt = buildThreadHandoffPrompt({
      ...base,
      mode: "full",
      transcriptLines: ['{"n":1}', `{"n":2,"big":"${"y".repeat(200_000)}"}`, '{"n":3}'],
    });
    expect(prompt).toContain('{"n":1}\n{"n":3}');
    expect(prompt).not.toContain('"n":2');
    expect(prompt).toContain("1 timeline items omitted");
  });

  it("fences text that contains backtick fences", () => {
    const prompt = buildThreadHandoffPrompt({ ...base, lastUserText: "```js\nx\n```" });
    expect(prompt).toContain("````text\n```js\nx\n```\n````");
  });
});
