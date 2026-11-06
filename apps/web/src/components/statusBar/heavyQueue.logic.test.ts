import type { HeavyQueueEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHeavyQueueRows, formatElapsed, ordinal } from "./heavyQueue.logic";

const entry = (id: string, over: Partial<HeavyQueueEntry> = {}): HeavyQueueEntry => ({
  id,
  pid: 1,
  threadId: null,
  label: `cmd ${id}`,
  cwd: "/work/app/",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  ...over,
});

describe("heavy queue logic", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [11, "11th"],
    [12, "12th"],
    [21, "21st"],
    [112, "112th"],
  ])("ordinal %i", (n, expected) => expect(ordinal(n)).toBe(expected));

  it("positions waiters, flags the running entry, and withholds promote from the first waiter", () => {
    const rows = buildHeavyQueueRows(
      [
        entry("a", { startedAt: "2026-01-01T00:00:01.000Z", threadId: "t1" }),
        entry("b"),
        entry("c", { threadId: "gone" }),
        entry("d", { threadId: "t1" }),
      ],
      (id) => (id === "t1" ? "Fix build" : undefined),
    );
    expect(rows.map((r) => [r.running, r.position, r.canPromote, r.subtitle])).toEqual([
      [true, null, false, "Fix build"],
      [false, 1, false, "app"],
      [false, 2, true, "app"],
      [false, 3, true, "Fix build"],
    ]);
  });

  it("falls back to the cwd for a blank title, a root path, and windows separators", () => {
    const rows = buildHeavyQueueRows(
      [entry("a", { threadId: "t", cwd: "C:\\src\\tool" }), entry("b", { cwd: "/" })],
      () => "",
    );
    expect(rows.map((r) => r.subtitle)).toEqual(["tool", "/"]);
  });

  it.each([
    [-5_000, "0s"],
    [12_000, "12s"],
    [125_000, "2m"],
    [3_725_000, "1h 2m"],
  ])("formats %i ms elapsed", (ms, expected) =>
    expect(
      formatElapsed("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z") + ms),
    ).toBe(expected),
  );
});
