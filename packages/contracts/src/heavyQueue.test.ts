import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  HeavyCommandsState,
  fillsStandardSlot,
  heavyHoldText,
  HeavyQueueHold,
} from "./heavyQueue.ts";

const decode = Schema.decodeUnknownSync(HeavyCommandsState);
const decodeHold = Schema.decodeSync(HeavyQueueHold);

const row = {
  pid: 12,
  startTimeMs: 1,
  threadId: null,
  label: "vp test run",
  name: "Tests",
  startedAt: "2026-01-01T00:00:00.000Z",
  stoppable: false,
};

describe("HeavyCommandsState", () => {
  it("decodes rows from servers that predate detached commands and reasons", () => {
    const old = { commands: [{ ...row, source: "agent", stoppable: true }], cpuCount: 8 };
    expect(decode(old)).toEqual(old);
  });

  it("decodes a detached command with its reason", () => {
    const detached = { ...row, source: "detached", reason: "Started outside an agent" };
    expect(decode({ commands: [detached], cpuCount: 8 }).commands).toEqual([detached]);
  });
});

describe("heavyHoldText", () => {
  it.each([
    ["reserved", "waiting for room for the head job"],
    ["draining", "waiting for the job that runs alone to start"],
    ["committed", "waiting for room: a job just started"],
    ["quick-slots", "2 quick jobs running"],
    ["commit-slot", "a commit is running"],
    ["other", "waiting for room"],
  ] as const)("names the %s hold", (hold, text) => {
    expect(heavyHoldText(hold, null, 3, 2)).toBe(text);
  });

  // An older client still decodes a newer server's state: a hold it does not know reads as "other".
  it.each([
    ["committed", "committed"],
    ["a-hold-from-a-newer-server", "other"],
  ])("decodes the %s hold as %s", (hold, decoded) => {
    expect(decodeHold(hold)).toBe(decoded);
  });
});

describe("fillsStandardSlot", () => {
  it.each([
    ["an entry without a class, from an older server", undefined, true],
    ["a standard job", { class: "standard", why: "" }, true],
    ["a commit classed standard", { class: "standard", why: "", commit: true }, false],
    ["a quick commit", { class: "quick", why: "", commit: true }, false],
    ["a quick job", { class: "quick", why: "" }, false],
    ["a service", { class: "service", why: "" }, false],
  ] as const)("%s", (_name, cost, fills) => {
    expect(fillsStandardSlot(cost)).toBe(fills);
  });
});
