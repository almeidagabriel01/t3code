import { formatAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { taskEventHeadline } from "@t3tools/shared/assistantTaskEvents";
import { GuestMessageId, ThreadId } from "@t3tools/contracts";
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

  const ada = {
    role: "user",
    createdBy: "agent" as const,
    senderThreadId: "assistant:ada:1",
    text: "<t3_reply>model-facing envelope</t3_reply>",
    context: {
      teammate: {
        entries: [
          {
            kind: "reply" as const,
            name: "Ada",
            handle: "ada",
            threadId: ThreadId.make("assistant:ada:1"),
            requestId: "m",
            files: [],
            text: "Status: done\nShipped.",
          },
        ],
      },
    },
  };

  it("shows a teammate's queued message as their words, not the envelope", () => {
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: false,
      canSendNow: true,
      text: ada.text,
      message: ada,
    });

    expect(controls.displayText).toBe("Shipped.");
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

  it.each([
    [
      "a guest's",
      {
        role: "user",
        text: "Why?",
        context: {
          guest: { guestMessageId: GuestMessageId.make("g1"), name: "Sam", text: "Why?" },
        },
      },
    ],
    ["a teammate's", ada],
    ["another agent's", { role: "user", text: "Ship it", createdBy: "agent" as const }],
  ])("lets the owner cancel %s queued message but not rewrite it", (_name, message) => {
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      text: message.text,
      message,
    });

    expect(controls.canEdit).toBe(false);
    expect(controls.canDismiss).toBe(true);
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
