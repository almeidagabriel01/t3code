import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  fillsStandardSlot,
  formatBytes,
  HeavyCommandsState,
  heavyHoldText,
  HeavyQueueHold,
  HeavyQueueOrderCode,
  linuxOverText,
} from "./heavyQueue.ts";

const decode = Schema.decodeUnknownSync(HeavyCommandsState);
const decodeHold = Schema.decodeSync(HeavyQueueHold);
const decodeOrder = Schema.decodeSync(HeavyQueueOrderCode);

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

  // Only this build and newer map an unknown hold to "other". Older clients stay safe because the
  // server never emits a hold literal they lack.
  it.each([
    [decodeHold, "committed", "committed"],
    [decodeHold, "a-hold-from-a-newer-server", "other"],
    [decodeOrder, "light", "light"],
    [decodeOrder, "an-order-from-a-newer-server", "other"],
  ])("decodes %#: %s as %s", (decodeCode, code, decoded) => {
    expect(decodeCode(code)).toBe(decoded);
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

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe("formatBytes", () => {
  // One formatter for every gauge and every reason, so the two never print one reading two ways.
  it.each([
    [0, "0 MB"],
    [-5 * MIB, "0 MB"],
    [1000, "1 MB"],
    [819 * MIB, "819 MB"],
    [GIB - MIB, "1023 MB"],
    [GIB, "1.0 GB"],
    [3.44 * GIB, "3.4 GB"],
  ])("%d bytes read %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("linuxOverText", () => {
  // Beside its gauge a limit names only its threshold: the gauge already shows the number.
  it.each([
    [
      { limit: "memory", value: 819 * MIB, threshold: 10 },
      "819 MB free, keeping 10%",
      "keeping 10% of memory free",
    ],
    [{ limit: "cpu", value: 92, threshold: 70 }, "CPU 92%, limit 70%", "CPU over its 70% limit"],
    // No gauge shows these readings, so they always carry them.
    [
      { limit: "memory-pressure", value: 57, threshold: 10 },
      "memory stalled 57% of the time (limit 10%)",
      "memory stalled 57% of the time (limit 10%)",
    ],
    [
      { limit: "swap", value: 0.2 * GIB, threshold: 10, total: 4 * GIB },
      "swap nearly full: 205 MB of 4.0 GB free",
      "swap nearly full: 205 MB of 4.0 GB free",
    ],
    [
      { limit: "io-pressure", value: 40, threshold: 30 },
      "disk stalled 40% of the time (limit 30%)",
      "disk stalled 40% of the time (limit 30%)",
    ],
    [
      { limit: "cpu-pressure", value: 95, threshold: 90 },
      "CPU saturated: work waited 95% of the time",
      "CPU saturated: work waited 95% of the time",
    ],
  ] as const)("%o reads %s, %s beside its gauge", (over, alone, beside) => {
    expect(linuxOverText(over)).toBe(alone);
    expect(linuxOverText(over, true)).toBe(beside);
  });
});
