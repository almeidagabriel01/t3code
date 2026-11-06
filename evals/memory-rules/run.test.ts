import { describe, expect, it } from "vite-plus/test";
import { casePasses, grade, type Rule } from "./grade.ts";

const rule = (over: Partial<Rule>): Rule => ({
  scope: "project",
  text: "Never push to main.",
  messageIds: ["u1"],
  supersedes: null,
  ...over,
});

describe("grade", () => {
  it.each([
    ["none, empty", { kind: "none" }, [], true],
    ["none, a rule", { kind: "none" }, [rule({})], false],
    ["rule, match", { kind: "rule", scope: "project", text: /main/i }, [rule({})], true],
    ["rule, wrong scope", { kind: "rule", scope: "user" }, [rule({})], false],
    ["rule, wrong text", { kind: "rule", scope: "project", text: /pnpm/i }, [rule({})], false],
    ["rule, empty", { kind: "rule", scope: "project" }, [], false],
    [
      "supersedes, match",
      { kind: "rule", scope: "project", supersedes: "m-npm" },
      [rule({ supersedes: "m-npm" })],
      true,
    ],
    [
      "supersedes, missing",
      { kind: "rule", scope: "project", supersedes: "m-npm" },
      [rule({})],
      false,
    ],
  ] as const)("%s", (_name, expectation, rules, pass) => {
    expect(grade(expectation, rules).pass).toBe(pass);
  });

  it.each([
    [[true], true],
    [[false], false],
    [[true, false], false],
    [[true, true, false], true],
    [[], false],
  ] as const)("casePasses %j", (samples, pass) => {
    expect(casePasses(samples.map((value) => ({ pass: value })))).toBe(pass);
  });
});
