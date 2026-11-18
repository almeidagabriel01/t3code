import { describe, expect, it } from "@effect/vitest";

import corpus from "./routingCorpus.fixture.json" with { type: "json" };
import { DEFAULT_PROJECT_CONFIG, eligibilityOf, type Verdict } from "./runner.ts";

// The checkouts the sanitized paths name; anything else is outside every checkout.
const CHECKOUT =
  /^(\/Users\/dev\/\.t3\/worktrees\/[^/]+\/[^/]+|\/Users\/dev\/DEV\/Pessoal\/t3code\/\.claude\/worktrees\/[^/]+|\/Users\/dev\/DEV\/Pessoal\/(?:t3code|game|game-e2e|Remotion))(?:\/|$)/;
const context = {
  config: { ...DEFAULT_PROJECT_CONFIG, runnerLinuxEverything: true },
  home: "/Users/dev",
  rootOf: (cwd: string) => CHECKOUT.exec(cwd)?.[1] ?? null,
};
const routeOf = ({ eligibility, mac }: Verdict) =>
  eligibility === "linux" || eligibility === "exclusive"
    ? eligibility
    : `${mac?.code}:${mac?.subject}`;

describe("routing corpus", () => {
  it.each(corpus.rows.map((row, at) => ({ ...row, name: `${at} ${row.line.slice(0, 90)}` })))(
    "$name",
    ({ line, cwd, scripts, expect: verdict }) => {
      const got = eligibilityOf(
        { label: line.slice(0, 200), line, cwd, scripts: scripts ?? {} },
        context,
      );
      expect(routeOf(got)).toBe(verdict);
    },
  );
});
