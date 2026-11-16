import { describe, expect, it } from "vite-plus/test";

import { isAssistantMessageFoldable } from "./assistantMessageFold";

const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");

describe("isAssistantMessageFoldable", () => {
  const base = { threadId: "assistant:a:1", streaming: false, turnInProgress: false, text: long };

  it.each([
    { name: "a finished long reply in an assistant thread", input: base, expected: true },
    { name: "a normal thread", input: { ...base, threadId: "thread-1" }, expected: false },
    { name: "a streaming reply", input: { ...base, streaming: true }, expected: false },
    { name: "a turn still running", input: { ...base, turnInProgress: true }, expected: false },
    { name: "a short reply", input: { ...base, text: "ok" }, expected: false },
  ])("$name -> $expected", ({ input, expected }) => {
    expect(isAssistantMessageFoldable(input)).toBe(expected);
  });
});
