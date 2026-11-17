import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
  });

  it("shows a /side draft as a side chat send, even while a turn runs", () => {
    for (const state of [idle, { ...idle, running: true, canSteer: true }]) {
      const presentation = resolveComposerSendPresentation({ ...state, sendsToSideChat: true });
      expect(presentation.label).toBe("Send to side chat");
      expect(presentation.icon).toBe("bubble.left.and.bubble.right");
      expect(presentation.offersFollowUpChoice).toBe(false);
    }
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
