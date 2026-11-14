import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isQuietReply,
  mayBecomeQuietToken,
  parseTaskEvent,
  taskEventHeadline,
  type TaskEventStatus,
  withoutQuietToken,
} from "./assistantTaskEvents.ts";

const task = ThreadId.make("mcp:launch:abc");

describe("parseTaskEvent", () => {
  it.each<TaskEventStatus>(["completed", "failed", "cancelled", "interrupted"])(
    "reads back the %s headline the server writes",
    (status) => {
      const text = `${taskEventHeadline({ title: "Fix (the) upload", threadId: task, status })}\n\nIts last message:\nDone.`;
      expect(parseTaskEvent({ id: "assistant-task:run-1", text, senderThreadId: task })).toEqual({
        threadId: task,
        title: "Fix (the) upload",
        status,
      });
    },
  );

  it.each([
    ["", "Task"],
    ["  ", "Task"],
  ])("reads back a headline whose title was %j", (title, expected) => {
    const text = taskEventHeadline({ title, threadId: task, status: "failed" });
    expect(parseTaskEvent({ id: "assistant-task:run-1", text, senderThreadId: task })).toEqual({
      threadId: task,
      title: expected,
      status: "failed",
    });
  });

  it("keeps the event when the headline is not T3's, without inventing a title or state", () => {
    expect(
      parseTaskEvent({ id: "assistant-task:run-1", text: "something else", senderThreadId: task }),
    ).toEqual({ threadId: task, title: null, status: null });
  });

  it.each([
    { id: "message:1", senderThreadId: task },
    { id: "assistant-task:run-1", senderThreadId: undefined },
  ])("ignores other messages: $id", (message) => {
    expect(parseTaskEvent({ ...message, text: "Task [x](t3-thread://v1/x) finished." })).toBeNull();
  });
});

describe("quiet replies", () => {
  it.each([
    ["NO_REPLY", true, "NO_REPLY"],
    ["  `NO_REPLY`\n", true, "  `NO_REPLY`\n"],
    ["**NO_REPLY**", true, "**NO_REPLY**"],
    ["NO_REPLY.", true, "NO_REPLY."],
    // Text before the token still says something: it goes out without the token.
    ["Task X failed in CI.\n\nNO_REPLY", false, "Task X failed in CI."],
    ["Nothing new.\n`NO_REPLY`", false, "Nothing new."],
    [
      "NO_REPLY is what I would say, but the build broke.",
      false,
      "NO_REPLY is what I would say, but the build broke.",
    ],
    ["Task finished: 3 files changed.", false, "Task finished: 3 files changed."],
    ["", false, ""],
  ])("%j → quiet %s, shown %j", (text, quiet, shown) => {
    expect(isQuietReply(text)).toBe(quiet);
    expect(withoutQuietToken(text)).toBe(shown);
  });

  it.each([
    ["N", true],
    ["NO_", true],
    ["`NO_REP", true],
    ["NO_REPLY", true],
    ["No", false],
    ["", false],
    ["NO_REPLYX", false],
  ])("%j may still become the token: %s", (line, may) => {
    expect(mayBecomeQuietToken(line)).toBe(may);
  });
});
