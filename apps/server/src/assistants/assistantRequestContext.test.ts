import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  ASSISTANT_CONTEXT_TOKEN_CEILING,
  ASSISTANT_REQUEST_GAP_MS,
  assistantSessionCut,
  openTasksNote,
} from "./assistantRequestContext.ts";

const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const ago = (ms: number) => DateTime.subtract(now, { milliseconds: ms });
const TYPED = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const base = {
  threadId: "assistant:jarvis:3",
  messageId: TYPED,
  now,
  lastRunEndedAt: ago(ASSISTANT_REQUEST_GAP_MS),
  usedTokens: 1_000,
  otherRunActive: false,
};

describe("assistantSessionCut", () => {
  it.each([
    ["typed in a client, at the gap", {}, "new_request"],
    ["from a channel", { messageId: "channel:c1:k" }, "new_request"],
    ["a scheduled task", { messageId: "scheduled-task-message:t:1:schedule" }, "new_request"],
    ["sent by an agent", { messageId: "message:mcp:op:abc" }, "new_request"],
    ["typed just inside the gap", { lastRunEndedAt: ago(ASSISTANT_REQUEST_GAP_MS - 1) }, null],
    ["the first run", { lastRunEndedAt: null }, null],
    ["an assistant's reply", { messageId: "assistant-reply:r1" }, null],
    ["an autonomy wake", { messageId: "autonomy-wake:x" }, null],
    ["a decision answer", { messageId: "decision-answer:d1" }, null],
    ["a wait notice", { messageId: "assistant-task-waits:x" }, null],
    ["a pull request watch", { messageId: "message:pr-watch:x" }, null],
    ["any unknown prefix", { messageId: "something:new" }, null],
    [
      "a wake past the ceiling",
      {
        messageId: "autonomy-wake:x",
        lastRunEndedAt: ago(1_000),
        usedTokens: ASSISTANT_CONTEXT_TOKEN_CEILING + 1,
      },
      "context_ceiling",
    ],
    [
      "a wake at the ceiling",
      {
        messageId: "autonomy-wake:x",
        usedTokens: ASSISTANT_CONTEXT_TOKEN_CEILING,
      },
      null,
    ],
    ["another run still at work", { otherRunActive: true, usedTokens: 90_000 }, null],
    [
      "a group thread",
      { threadId: "assistant:jarvis:g-0123456789abcdef", usedTokens: 90_000 },
      null,
    ],
    ["an ordinary thread", { threadId: "thread-1", usedTokens: 90_000 }, null],
    ["an assistant id holding a colon", { threadId: "assistant:team:a:2" }, "new_request"],
  ] as const)("%s → %s", (_case, overrides, expected) => {
    assert.strictEqual(assistantSessionCut({ ...base, ...overrides }), expected);
  });
});

it("lists open tasks with id, title and status, capped and on one line each", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    threadId: `thread-${index}`,
    title: index === 0 ? "Fix\nthe   build" : `Task ${index}`,
    status: "running",
  }));
  const note = openTasksNote(tasks);
  assert.include(note, "- thread-0 · Fix the build · running");
  assert.notInclude(note, "thread-10");
  assert.include(openTasksNote([]), "- none");
});
