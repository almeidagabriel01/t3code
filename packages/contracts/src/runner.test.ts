import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { RunnerOfflineAfterFailures } from "./runner.ts";

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
});
