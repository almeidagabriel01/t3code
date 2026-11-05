import { describe, expect, it } from "vite-plus/test";
import { MessageId, ThreadId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([
        { id: "image-only", rowIndex: 0, userText: "", assistantText: null, assistantId: null },
      ]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );

  it("marks a message an assistant wrote with that assistant", () => {
    const at = "2026-10-01T00:00:00Z";
    const items = deriveTimelineMinimapItems([
      {
        kind: "message",
        id: "from-assistant",
        createdAt: at,
        showAssistantMeta: false,
        showAssistantCopyButton: false,
        assistantCopyStreaming: false,
        message: {
          id: MessageId.make("from-assistant"),
          role: "user",
          text: "Check the folder rule first",
          senderThreadId: ThreadId.make("assistant:jarvis:1"),
          runId: null,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
    ]);
    expect(items[0]?.assistantId).toBe("jarvis");
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantId: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });
});
