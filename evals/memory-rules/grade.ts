export type Rule = {
  readonly scope: "project" | "user";
  readonly text: string;
  readonly messageIds: ReadonlyArray<string>;
  readonly supersedes: string | null;
};

export type Expectation =
  | { readonly kind: "none" }
  | {
      readonly kind: "rule";
      readonly scope: "project" | "user";
      readonly text?: RegExp;
      readonly supersedes?: string;
    };

export function grade(expect: Expectation, rules: ReadonlyArray<Rule>) {
  if (expect.kind === "none")
    return rules.length === 0
      ? { pass: true, reason: "no rules" }
      : { pass: false, reason: `unexpected rules: ${rules.map((rule) => rule.text).join(" | ")}` };
  const match = rules.find(
    (rule) =>
      rule.scope === expect.scope &&
      (!expect.text || expect.text.test(rule.text)) &&
      (expect.supersedes === undefined || rule.supersedes === expect.supersedes),
  );
  return match
    ? { pass: true, reason: `matched: ${match.text}` }
    : {
        pass: false,
        reason: rules.length === 0 ? "no rules" : `no matching rule in: ${JSON.stringify(rules)}`,
      };
}

/** A case fails when half or more of its samples fail. */
export function casePasses(samples: ReadonlyArray<{ readonly pass: boolean }>) {
  return samples.length > 0 && samples.filter((sample) => !sample.pass).length * 2 < samples.length;
}

export type Obedience = { readonly endsWith: string } | { readonly absent: string };

export function gradeObedience(expect: Obedience, answer: string) {
  const pass =
    "endsWith" in expect
      ? answer.trim().endsWith(expect.endsWith)
      : !answer.includes(expect.absent);
  return { pass, reason: pass ? "ok" : `answer: ${answer.trim().slice(-200)}` };
}
