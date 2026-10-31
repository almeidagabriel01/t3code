import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  Assistant,
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

describe("Assistant", () => {
  const decode = Schema.decodeUnknownSync(Assistant);
  const row = {
    id: "jarvis",
    handle: "jarvis",
    name: "Jarvis",
    projectId: "project-1",
    instructions: "",
    toolAccess: "full",
    isDefault: true,
    threadId: null,
    generation: 1,
    archivedAt: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  };

  it("reads a row saved before budgets existed as having no budget", () => {
    expect(decode(row).budget).toBeNull();
  });

  it("keeps a budget, filling the provider budget defaults", () => {
    const budget = decode({
      ...row,
      budget: { amountUsd: 5, period: "monthly", timeZone: "America/Sao_Paulo" },
    }).budget;
    expect(budget).toEqual({
      amountUsd: 5,
      period: "monthly",
      warnAtPercent: 80,
      blockWhenExceeded: false,
      timeZone: "America/Sao_Paulo",
    });
  });
});
