import { describe, expect, it } from "vite-plus/test";

import { formatRowWorkingDurationLabel } from "./models.ts";

describe("formatRowWorkingDurationLabel", () => {
  it.each([
    [-5_000, "<1m"],
    [0, "<1m"],
    [59_999, "<1m"],
    [60_000, "1m"],
    [3_660_000, "1h 1m"],
    [Number.NaN, "<1m"],
  ])("labels %d ms as %s", (elapsedMs, label) => {
    expect(formatRowWorkingDurationLabel(elapsedMs)).toBe(label);
  });
});
