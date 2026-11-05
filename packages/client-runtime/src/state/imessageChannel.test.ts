import { assert, describe, it } from "@effect/vitest";
import type { ImessageChannelSettings, ImessageChannelStatusEvent } from "@t3tools/contracts";

import {
  applyImessageStatusEvent,
  compactImessageHandle,
  formatImessageHandleInput,
  imessageDefaultCallingCode,
  imessageSuggestedSelfHandles,
} from "./imessageChannel.ts";

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

describe("formatImessageHandleInput", () => {
  it.each([
    ["", "55", ""],
    ["+", "55", "+"],
    ["3", "55", "+55 (3"],
    ["35999", "55", "+55 (35) 999"],
    ["35999998888", "55", "+55 (35) 99999-8888"],
    ["3533334444", "55", "+55 (35) 3333-4444"],
    ["(35) 99999-8888", "55", "+55 (35) 99999-8888"],
    ["5535999998888", "55", "+55 (35) 99999-8888"],
    ["+55 (", "55", "+55"],
    ["+55 (35) 99999-88889", "55", "+55 (35) 99999-8888"],
    ["5551234567", "1", "+1 (555) 123-4567"],
    ["15551234567", "1", "+1 (555) 123-4567"],
    ["+351912345678", "55", "+351912345678"],
    ["35999998888", undefined, "+35999998888"],
    ["Me@Example.com", "55", "Me@Example.com"],
  ])("formats %j with calling code %s as %j", (input, code, expected) => {
    assert.strictEqual(formatImessageHandleInput(input, code), expected);
  });
});

describe("compactImessageHandle", () => {
  it("drops mask separators from numbers and lowercases emails", () => {
    assert.strictEqual(compactImessageHandle("+55 (35) 99999-8888"), "+5535999998888");
    assert.strictEqual(compactImessageHandle(" Me@Example.com "), "me@example.com");
  });
});

describe("imessageSuggestedSelfHandles", () => {
  it("offers only the Mac's handles that neither list has, however they are written", () => {
    assert.deepEqual(
      imessageSuggestedSelfHandles(["me@example.com", "+15551234567", "+15550000001"], {
        selfHandles: ["Me@Example.com"],
        allowedHandles: ["+1 (555) 000-0001"],
      }),
      ["+15551234567"],
    );
  });
});

describe("imessageDefaultCallingCode", () => {
  it.each([
    [["en-BR", "pt-BR"], "55"],
    [["en", "pt_BR"], "55"],
    [["en-US"], "1"],
    [["zz-QQ", "pt-PT"], "351"],
    [["en"], undefined],
  ])("reads %j as %s", (locales, expected) => {
    assert.strictEqual(imessageDefaultCallingCode(locales), expected);
  });
});
