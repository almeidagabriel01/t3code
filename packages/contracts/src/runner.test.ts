import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RunnerOfflineAfterFailures, RunnerProjectConfig } from "./runner.ts";

const decodeProjectConfig = Schema.decodeUnknownSync(RunnerProjectConfig);

describe("Runner settings", () => {
  const decode = Schema.decodeUnknownOption(RunnerOfflineAfterFailures);
  it.each([
    [1, 2],
    [2, 2],
    [10, 10],
    [0, null],
    [11, null],
    [2.5, null],
  ])("Linux offline after %s failures reads as %s", (stored, read) => {
    const result = decode(stored);
    expect(result._tag === "Some" ? result.value : null).toBe(read);
  });

  it("reads a project config saved with the retired Linux allowlist, and drops it", () => {
    const current = {
      runnerEnabled: true,
      runnerWhere: "linux",
      runnerUnavailable: "ask",
      runnerAskMinutes: 5,
      runnerDeadlineAction: "mac",
      runnerDropped: "agent",
      runnerMacOnly: ["xcodebuild"],
      runnerMacFirstAfter: 4,
      runnerBringBack: false,
    };
    const saved = { ...current, runnerLinuxCommands: ["test"], runnerLinuxEverything: false };
    // Saved before route memory existed, it reads that default too.
    expect(decodeProjectConfig(saved)).toEqual({ ...current, runnerRouteMemoryDays: 7 });
  });
});
