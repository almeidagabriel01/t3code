import { describe, expect, it } from "vitest";

import { textSelectable } from "./typography";

describe("textSelectable", () => {
  it.each([
    { platform: "android", props: { selectable: true, numberOfLines: 1 }, expected: false },
    { platform: "android", props: { selectable: true }, expected: true },
    { platform: "ios", props: { selectable: true, numberOfLines: 1 }, expected: true },
  ])("$platform with $props", ({ platform, props, expected }) => {
    expect(textSelectable(platform, props)).toBe(expected);
  });
});
