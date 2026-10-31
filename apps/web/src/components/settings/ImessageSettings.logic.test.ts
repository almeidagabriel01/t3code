import { expect, it } from "vite-plus/test";

import {
  imessageAccessState,
  imessageDeliveryErrorLabel,
  imessageErrorLabel,
  imessageStatusLabel,
  imessageSwitchHint,
} from "./ImessageSettings.logic";

it.each([
  [{ status: "disabled" }, "Off"],
  [{ status: "running" }, "Running"],
  [{ status: "error", lastError: "full_disk_access_missing" }, "Full Disk Access"],
  [{ status: "error", lastError: "database_unavailable" }, "Messages database"],
  [{ status: "error", lastError: "automation_denied" }, "Automation"],
  [{ status: "error", lastError: "messages_not_signed_in" }, "not signed in"],
  [{ status: "error" }, "stopped working"],
] as const)("labels %j", (settings, expected) => {
  expect(imessageStatusLabel(settings)).toContain(expected);
});

it("gives each error code a sentence", () => {
  expect(imessageErrorLabel("automation_denied")).toContain("control Messages");
});

it.each([
  ["ok", true, null],
  [null, false, "Full Disk Access"],
  ["full_disk_access_missing", false, "Full Disk Access"],
  ["messages_not_signed_in", false, "not signed in"],
  ["database_unavailable", false, "Messages database"],
] as const)("access %s", (access, granted, text) => {
  const state = imessageAccessState(access);
  expect(state.granted).toBe(granted);
  if (text === null) expect(state.message).toBeNull();
  else expect(state.message).toContain(text);
});

it.each([
  [false, 0, "Full Disk Access and add"],
  [false, 2, "Grant Full Disk Access before"],
  [true, 0, "Add at least one"],
  [true, 1, null],
] as const)("switch hint granted=%s handles=%s", (granted, handleCount, expected) => {
  const hint = imessageSwitchHint({ granted, handleCount });
  if (expected === null) expect(hint).toBeNull();
  else expect(hint).toContain(expected);
});

it("describes a failed delivery with its age and reason", () => {
  const now = Date.parse("2026-10-01T01:00:00.000Z");
  expect(
    imessageDeliveryErrorLabel({ code: "chat_not_found", at: "2026-10-01T00:00:00.000Z" }, now),
  ).toBe("The last reply was not delivered (1h ago, the chat was not found in Messages).");
  expect(imessageDeliveryErrorLabel({ code: "timeout", at: "not a date" }, now)).toBe(
    "The last reply was not delivered (Messages did not answer in time).",
  );
});
