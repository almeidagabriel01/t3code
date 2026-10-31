import { assert, describe, it } from "@effect/vitest";
import type {
  SlackChannelConnectionId,
  SlackChannelSettings,
  SlackChannelStatusEvent,
} from "@t3tools/contracts";

import { applySlackStatusEvent } from "./slackChannel.ts";

const connectionId = "slack-0123456789ab" as SlackChannelConnectionId;
const settings: SlackChannelSettings = {
  connectionId,
  enabled: true,
  hasAppToken: true,
  hasBotToken: true,
  allowedChannelIds: [],
  status: "error",
  lastError: "token_revoked",
};

describe("applySlackStatusEvent", () => {
  it("replaces status and errors, and ignores another connection", () => {
    const event: SlackChannelStatusEvent = {
      connectionId,
      status: "connected",
      teamId: "T0000000001",
      botUserId: "U0000000002",
      lastDeliveryError: { code: "rate_limited", at: "2026-10-01T00:00:00.000Z" },
    };
    const { lastError: _gone, ...withoutError } = settings;
    assert.deepStrictEqual(applySlackStatusEvent(settings, event), {
      ...withoutError,
      status: "connected",
      teamId: "T0000000001",
      botUserId: "U0000000002",
      lastDeliveryError: { code: "rate_limited", at: "2026-10-01T00:00:00.000Z" },
    });
    assert.deepStrictEqual(
      applySlackStatusEvent(settings, { connectionId, status: "connecting", lastError: "x" }),
      { ...withoutError, status: "connecting", lastError: "x" },
    );
    assert.strictEqual(
      applySlackStatusEvent(settings, {
        connectionId: "slack-other" as SlackChannelConnectionId,
        status: "connected",
      }),
      settings,
    );
  });
});
