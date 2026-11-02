import { describe, expect, it } from "vite-plus/test";

import { isCardNavKey, nextCardFocus, type CardNavKey } from "./boardNav";

const columns = [
  { cardIds: ["a1", "a2", "a3"] },
  { cardIds: [] },
  { cardIds: ["c1", "c2"] },
  { cardIds: ["d1"] },
];

describe("nextCardFocus", () => {
  it.each<[string, CardNavKey, string | null]>([
    ["a2", "ArrowUp", "a1"],
    ["a2", "ArrowDown", "a3"],
    ["a1", "ArrowUp", null],
    ["a3", "ArrowDown", null],
    ["a3", "ArrowRight", "c2"],
    ["a1", "ArrowRight", "c1"],
    ["c2", "ArrowLeft", "a2"],
    ["c2", "ArrowRight", "d1"],
    ["d1", "ArrowRight", null],
    ["a1", "ArrowLeft", null],
    ["nope", "ArrowDown", null],
  ])("%s %s -> %s", (id, key, expected) => {
    expect(nextCardFocus(columns, id, key)).toBe(expected);
  });

  it("recognizes only arrow keys", () => {
    expect(isCardNavKey("ArrowLeft")).toBe(true);
    expect(isCardNavKey("Enter")).toBe(false);
  });
});
