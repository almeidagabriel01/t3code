import { expect, it } from "vite-plus/test";

import { parseChannelId, slackDeliveryErrorLabel, slackStatusLabel } from "./SlackSettings.logic";

it.each([
  [{ status: "disabled" }, "Off"],
  [{ status: "connecting" }, "Connecting…"],
  [{ status: "connected", teamId: "T01" }, "Connected to T01"],
  [{ status: "connected" }, "Connected"],
  [{ status: "reconnecting" }, "Reconnecting…"],
  [{ status: "error", lastError: "token_revoked" }, "Slack revoked a token"],
  [{ status: "error", lastError: "app_uninstalled" }, "removed from the workspace"],
  [{ status: "error", lastError: "invalid_token" }, "rejected a saved token"],
  [{ status: "error", lastError: "workspace_mismatch" }, "different Slack workspaces"],
  [{ status: "error", lastError: "missing_token" }, "A token is missing"],
  [{ status: "error", lastError: "something_new" }, "could not connect"],
  [{ status: "error" }, "could not connect"],
] as const)("labels %j", (settings, expected) => {
  expect(slackStatusLabel(settings)).toContain(expected);
});

it("describes a failed delivery with its age and reason", () => {
  const now = Date.parse("2026-10-01T01:00:00.000Z");
  expect(
    slackDeliveryErrorLabel({ code: "not_in_channel", at: "2026-10-01T00:00:00.000Z" }, now),
  ).toBe(
    "The last reply was not delivered (1h ago, the bot is not in that channel, invite it first).",
  );
  expect(slackDeliveryErrorLabel({ code: "rate_limited", at: "not a date" }, now)).toBe(
    "The last reply was not delivered (Slack is rate limiting replies).",
  );
});

it.each([
  ["c0123456789", "C0123456789"],
  ["  G0123456789 ", "G0123456789"],
])("accepts %j", (input, id) => {
  expect(parseChannelId(input, [])).toEqual({ ok: true, id });
});

it.each([
  ["", []],
  ["D0123456789", []],
  ["C123", []],
  ["#general", []],
  ["C0123456789", ["C0123456789"]],
])("rejects %j", (input, existing) => {
  expect(parseChannelId(input, existing).ok).toBe(false);
});
