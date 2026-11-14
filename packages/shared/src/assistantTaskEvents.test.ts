import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isQuietReply,
  parseTaskEvent,
  taskEventHeadline,
  type TaskEventStatus,
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

describe("isQuietReply", () => {
  it.each([
    ["NO_REPLY", true],
    ["  `NO_REPLY`\n", true],
    ["**NO_REPLY**", true],
    ["NO_REPLY.", true],
    ["Nothing new since the last report.\n\nNO_REPLY", true],
    ["NO_REPLY is what I would say, but the build broke.", false],
    ["Task finished: 3 files changed.", false],
    ["", false],
  ])("%j → %s", (text, quiet) => {
    expect(isQuietReply(text)).toBe(quiet);
  });
});
