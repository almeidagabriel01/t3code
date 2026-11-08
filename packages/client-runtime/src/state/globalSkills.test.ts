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
});
