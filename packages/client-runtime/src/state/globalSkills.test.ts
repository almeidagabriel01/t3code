import { describe, expect, it } from "vite-plus/test";
import { t3SkillsOf } from "./globalSkills.ts";

describe("t3SkillsOf", () => {
  it("keeps one copy of each T3 skill across providers and ignores the providers' own", () => {
    const one = { name: "t3:one", path: "/skills/one", scope: "t3", enabled: true };
    const own = {
      name: "review",
      path: "/home/.claude/skills/review",
      scope: "user",
      enabled: true,
    };
    expect(t3SkillsOf([{ skills: [one, own] }, { skills: [one] }])).toEqual([one]);
    expect(t3SkillsOf(undefined)).toEqual([]);
  });

  const slim = { name: "t3:one", path: "/skills/one", scope: "t3", enabled: true };
  const described = { ...slim, description: "Does one thing" };
  const other = { name: "t3:two", path: "/skills/two", scope: "t3", enabled: true };
  it.each([
    { name: "slim copy first", providers: [[slim], [described]], expected: [described] },
    { name: "described copy first", providers: [[described], [slim]], expected: [described] },
    { name: "every copy slim", providers: [[slim], [slim]], expected: [slim] },
    {
      name: "order follows first sight",
      providers: [[slim, other], [described]],
      expected: [described, other],
    },
  ])("prefers the copy that carries a description: $name", ({ providers, expected }) => {
    expect(t3SkillsOf(providers.map((skills) => ({ skills })))).toEqual(expected);
  });
});
