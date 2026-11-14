import { describe, expect, it } from "@effect/vitest";

import { projectNoticePrefix } from "./projectNotice.ts";

describe("projectNoticePrefix", () => {
  it.each([
    ["t3code", "Done.", "[t3code] Done."],
    ["My app", "", "[My app] "],
    ["a<b", "x", "[a<b] x"],
  ])("%s + %j", (title, text, expected) => {
    expect(projectNoticePrefix(title, text)).toBe(expected);
  });
});
