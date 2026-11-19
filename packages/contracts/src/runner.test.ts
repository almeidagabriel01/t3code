import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RUNNER_DEFAULTS, RunnerOfflineAfterFailures, RunnerProjectConfig } from "./runner.ts";

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

  it("lists every program the Always-on-this-Mac defaults name as a Mac-only tool", () => {
    // Bare program names; "simulator" is a word in a command, not a program.
    const programs = RUNNER_DEFAULTS.runnerMacOnly.filter(
      (pattern) => /^[\w-]+$/.test(pattern) && pattern !== "simulator",
    );
    const missing = programs.filter((program) => !RUNNER_DEFAULTS.runnerMacTools.includes(program));
    expect(missing).toEqual([]);
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
    // Saved before route memory, the bring-back limits and the Mac tools existed, it reads their defaults too.
    expect(decodeProjectConfig(saved)).toEqual({
      ...current,
      runnerLinuxFull: "wait",
      runnerRouteMemoryDays: 7,
      runnerRouteLearnAfter: 2,
      runnerBringBackExclude: RUNNER_DEFAULTS.runnerBringBackExclude,
      runnerBringBackMaxMB: 200,
      runnerMacTools: RUNNER_DEFAULTS.runnerMacTools,
    });
  });
});
