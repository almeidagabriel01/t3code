import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistantHandle,
  assistantHandleFromName,
  assistantIdFromThreadId,
  assistantThreadIdFor,
  isAssistantThreadId,
} from "./assistants.ts";

const isAssistantHandle = Schema.is(AssistantHandle);

describe("assistantHandleFromName", () => {
  it.each([
    ["Jarvis", "jarvis"],
    ["  Code Reviewer  ", "code-reviewer"],
    ["Assistente de Revisão", "assistente-de-revisao"],
    ["Ünïcödé Ñame", "unicode-name"],
    ["--hi--", "hi"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)} b`, "a".repeat(31)],
    ["🤖", null],
    ["", null],
  ])("%j → %j", (name, handle) => {
    const result = assistantHandleFromName(name);
    expect(result).toBe(handle);
    if (result !== null) expect(isAssistantHandle(result)).toBe(true);
  });
});

describe("assistant thread ids", () => {
  it.each([
    ["jarvis", 1],
    ["0f6c-uuid-with:colon", 12],
  ])("round-trips %s generation %i", (assistantId, generation) => {
    const threadId = assistantThreadIdFor(assistantId, generation);
    expect(isAssistantThreadId(threadId)).toBe(true);
    expect(assistantIdFromThreadId(threadId)).toBe(assistantId);
  });

  it.each(["thread-1", "mcp:abc", "assistant:", "assistant:nogeneration", "Assistant:jarvis:1"])(
    "rejects %s",
    (threadId) => {
      expect(assistantIdFromThreadId(threadId)).toBeNull();
    },
  );
});
