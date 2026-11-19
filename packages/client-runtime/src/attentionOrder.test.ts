import { describe, expect, it } from "vite-plus/test";

import {
  attentionTierOfMood,
  compareAttention,
  sortByAttention,
  type AttentionKey,
} from "./attentionOrder.ts";

describe("compareAttention", () => {
  it.each<[string, AttentionKey, AttentionKey, "first" | "second" | "tie"]>([
    [
      "needs you beats working",
      { tier: "needsYou", activityAt: 1 },
      { tier: "working", activityAt: 9 },
      "first",
    ],
    [
      "working beats rest",
      { tier: "rest", activityAt: 9 },
      { tier: "working", activityAt: 1 },
      "second",
    ],
    [
      "needs you beats newer rest",
      { tier: "needsYou", activityAt: 0 },
      { tier: "rest", activityAt: 9 },
      "first",
    ],
    [
      "same tier: newer first",
      { tier: "rest", activityAt: 5 },
      { tier: "rest", activityAt: 7 },
      "second",
    ],
    [
      "same tier and time tie",
      { tier: "working", activityAt: 3 },
      { tier: "working", activityAt: 3 },
      "tie",
    ],
  ])("%s", (_name, a, b, expected) => {
    const result = Math.sign(compareAttention(a, b));
    expect(result).toBe(expected === "first" ? -1 : expected === "second" ? 1 : 0);
  });
});

describe("attentionTierOfMood", () => {
  it.each([
    ["needs", "needsYou"],
    ["working", "working"],
    ["failed", "rest"],
    ["idle", "rest"],
  ] as const)("%s reads %s", (mood, tier) => {
    expect(attentionTierOfMood(mood)).toBe(tier);
  });
});

describe("sortByAttention", () => {
  const items = [
    { name: "idle-old", key: { tier: "rest", activityAt: 1 } },
    { name: "idle-new", key: { tier: "rest", activityAt: 5 } },
    { name: "working", key: { tier: "working", activityAt: 0 } },
    { name: "waits", key: { tier: "needsYou", activityAt: 0 } },
    { name: "tie-b", key: { tier: "rest", activityAt: 3 } },
    { name: "tie-a", key: { tier: "rest", activityAt: 3 } },
  ] satisfies ReadonlyArray<{ name: string; key: AttentionKey }>;

  it("orders waits, then work, then the latest activity, keeping input order on ties", () => {
    expect(sortByAttention(items, (item) => item.key).map((item) => item.name)).toEqual([
      "waits",
      "working",
      "idle-new",
      "tie-b",
      "tie-a",
      "idle-old",
    ]);
  });

  it("breaks ties with the caller's own rule", () => {
    const sorted = sortByAttention(
      items,
      (item) => item.key,
      (a, b) => a.name.localeCompare(b.name),
    );
    expect(sorted.map((item) => item.name).slice(3, 5)).toEqual(["tie-a", "tie-b"]);
  });

  it("does not reorder its input", () => {
    const input = [...items];
    sortByAttention(input, (item) => item.key);
    expect(input).toEqual(items);
  });
});
