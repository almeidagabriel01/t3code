import { assert, describe, it } from "@effect/vitest";
import type { ImessageChannelSettings, ImessageChannelStatusEvent } from "@t3tools/contracts";

import { applyImessageStatusEvent } from "./imessageChannel.ts";

const settings: ImessageChannelSettings = {
  enabled: true,
  allowedHandles: ["+15550000000"],
  selfHandles: [],
  status: "error",
  lastError: "full_disk_access_missing",
};

describe("applyImessageStatusEvent", () => {
  it("replaces status and errors and keeps the handles", () => {
    const event: ImessageChannelStatusEvent = {
      status: "error",
      lastError: "automation_denied",
      lastDeliveryError: { code: "automation_denied", at: "2026-10-01T00:00:00.000Z" },
    };
    assert.deepStrictEqual(applyImessageStatusEvent(settings, event), {
      enabled: true,
      allowedHandles: ["+15550000000"],
      selfHandles: [],
      status: "error",
      lastError: "automation_denied",
      lastDeliveryError: { code: "automation_denied", at: "2026-10-01T00:00:00.000Z" },
    });
    const { lastError: _gone, ...withoutError } = settings;
    assert.deepStrictEqual(applyImessageStatusEvent(settings, { status: "running" }), {
      ...withoutError,
      status: "running",
    });
  });
});
