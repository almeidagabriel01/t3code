import { describe, expect, it } from "vite-plus/test";

import { formatRowWorkingDurationLabel, presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

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

describe("presentThreadShell oldestPendingGuestMessageAt", () => {
  it.each([
    { name: "no guest waits", count: 0, at: undefined, expected: null },
    {
      name: "the server's time",
      count: 1,
      at: "2026-06-19T10:00:00.000Z",
      expected: "2026-06-19T10:00:00.000Z",
    },
    // Older servers send the count alone, so the shell's last change stands in.
    { name: "an older server", count: 1, at: undefined, expected: "2026-06-20T00:00:00.000Z" },
  ])("$name", ({ count, at, expected }) => {
    const shell = presentThreadShell("environment-local" as never, {
      ...v2ThreadShell,
      pendingGuestMessageCount: count,
      ...(at === undefined ? {} : { oldestPendingGuestMessageAt: at }),
    });
    expect(shell.oldestPendingGuestMessageAt).toBe(expected);
  });
});
