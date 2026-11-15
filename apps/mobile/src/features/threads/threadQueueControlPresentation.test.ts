import { formatAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { taskEventHeadline } from "@t3tools/shared/assistantTaskEvents";
import { describe, expect, it } from "vite-plus/test";

import { queuedRowTitle, resolveThreadQueueRowControls } from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it.each([
    { busy: false, isEditing: false, expected: true },
    { busy: true, isEditing: false, expected: false },
    { busy: false, isEditing: true, expected: false },
  ])(
    "gates sending a stopped thread's queued message with $busy busy and $isEditing editing",
    ({ busy, isEditing, expected }) => {
      const controls = resolveThreadQueueRowControls({
        busy,
        isEditing,
        canPromoteToSteer: false,
        canSendNow: true,
        text: "Queued message",
      });

      expect(controls.canSend).toBe(expected);
    },
  );

  it("shows an assistant quote as its quoted text", () => {
    const href = formatAssistantCitationHref({
      version: 1,
      environmentId: "environment:test" as never,
      threadId: "thread:test" as never,
      messageId: "message:assistant" as never,
      text: "Retry the sync after the lock clears.",
      start: 0,
      end: 37,
      prefix: "",
      suffix: "",
    });
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      text: `[Assistant quote](${href}) Can we add a backoff here?`,
    });

    expect(controls.displayText).toBe(
      "Retry the sync after the lock clears. Can we add a backoff here?",
    );
  });

  it("keeps the row already open in the composer from being reopened or steered", () => {
    const editing = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isEditing: true,
      text: "Being edited",
    });

    expect(editing.isEditing).toBe(true);
    expect(editing.canEdit).toBe(false);
    expect(editing.canSend).toBe(false);
    expect(editing.canDismiss).toBe(true);
  });

  it("lets the owner cancel a guest's queued message but not rewrite it", () => {
    const guest = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isGuestMessage: true,
      text: "Why?",
    });

    expect(guest.canEdit).toBe(false);
    expect(guest.canDismiss).toBe(true);
  });
});

describe("queuedRowTitle", () => {
  const task = "mcp:launch:task" as never;
  const event = {
    id: "assistant-task:r1",
    text: taskEventHeadline({ title: "Add retry", threadId: task, status: "failed" }),
    senderThreadId: task,
  };

  it.each([
    {
      message: event,
      displayText: "raw headline",
      hasAttachments: false,
      expected: "Add retry · Failed",
    },
    { message: undefined, displayText: "Hello", hasAttachments: true, expected: "Hello" },
    { message: undefined, displayText: "", hasAttachments: true, expected: "Attachments" },
    { message: undefined, displayText: "", hasAttachments: false, expected: "Queued message" },
  ])("titles $expected", ({ expected, ...input }) => {
    expect(queuedRowTitle(input)).toBe(expected);
  });
});
