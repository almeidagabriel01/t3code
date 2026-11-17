import { describe, expect, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";

import { costOf } from "./costClass.ts";

const QUICK_SECONDS = 30;
const cost = (line: string, durationMs: number | null = null) =>
  costOf({ label: line.slice(0, 200), line }, durationMs, QUICK_SECONDS);

/** The cost-class case table: line, usual duration, class, why. */
describe("cost class", () => {
  it.each([
    [1, `for f in a.ts; do vp fmt --stdin-filepath="$f" < "$f"; done`, null, "quick", "1 file"],
    [
      2,
      `remoto bash -c 'files=(apps/a.ts); for f in "\${files[@]}"; do vp fmt --stdin-filepath="$f" < "$f" | diff -q - "$f"; done'`,
      null,
      "quick",
      "1 file",
    ],
    [3, "vp fmt apps/x.ts apps/y.ts", null, "quick", "2 files"],
    [4, "vp lint --no-ignore a.ts b.ts", null, "quick", "2 files"],
    [5, `vp lint --no-ignore "\${files[@]}"`, null, "standard", "first run"],
    [6, `vp lint --no-ignore "\${files[@]}"`, 6_000, "quick", "usually 6 s"],
    [7, "vp lint", 53_000, "standard", "usually 53 s"],
    [10, "cd apps/server && vp run typecheck", 11_000, "quick", "usually 11 s"],
    [11, "pnpm exec effect-tsgo tsrs --noEmit", 62_000, "standard", "usually 62 s"],
    [12, "vp test run x.test.ts", null, "quick", "1 file"],
    ["12b", "vp test run x.browser.test.tsx", null, "standard", "first run"],
    ["12c", "bash scripts/e2e.sh", null, "standard", "first run"],
    ["12c", "node build.mjs", null, "standard", "first run"],
    [13, "vp test run", 140_000, "standard", "usually 2 min"],
    [14, "vp run dev", null, "service", "keeps running"],
    [15, "vp run dev:desktop", null, "service", "keeps running"],
    [16, "npx expo start", null, "service", "keeps running"],
    [16, "vp test --watch", null, "service", "keeps running"],
    [16, "pnpm exec vitest watch", null, "service", "keeps running"],
    ["16b", "vp lint a.ts && vp run dev", null, "standard", "part of it keeps running"],
    [
      20,
      `python3 - <<'EOF'\np='a.ts'\nEOF\nvp fmt --stdin-filepath="$f" < "$f"`,
      null,
      "quick",
      "1 file",
    ],
    [8, `git commit -m "fix: x" a.ts`, 600_000, "quick", "staged files"],
    [
      "snapshot",
      "node --test src/lib/a.test.ts src/lib/b.test.ts > $TMPDIR/dois.log 2>&1; echo SAIDA=$?",
      null,
      "quick",
      "2 files",
    ],
    ["dir", "vp lint apps/web", null, "standard", "first run"],
    ["glob", "vp fmt 'src/**/*.ts'", null, "standard", "first run"],
    // A config or project file names how to check, not what: the check is the whole project.
    ["config", "tsc --noEmit -p apps/web/tsconfig.json", null, "standard", "first run"],
    ["config", "pnpm exec tsc --project tsconfig.json", null, "standard", "first run"],
    ["config", "vp lint --config oxlint.json", null, "standard", "first run"],
    ["config", "vp lint -c oxlint.json src/a.ts", null, "quick", "1 file"],
    // A watcher by its flag or script name, after a workspace selector too; a flag turned off is not.
    ["watch", "vp test run --watch=false", null, "standard", "first run"],
    ["watch", "pnpm run test:watch", null, "service", "keeps running"],
    ["watch", "pnpm build:watch", null, "service", "keeps running"],
    ["watch", "pnpm --filter web dev", null, "service", "keeps running"],
    ["watch", "vp run -F web dev", null, "service", "keeps running"],
  ])("row %s: %s", (_row, line, durationMs, kind, why) => {
    expect(cost(line, durationMs)).toEqual({ class: kind, why });
  });

  const NOW = Date.parse("2026-01-01T01:00:00.000Z");
  const running = (ranMin: number, idleMin: number | null) => ({
    label: "node server.js",
    startedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - ranMin * 60_000)),
    ...(idleMin === null ? {} : { idleSince: NOW - idleMin * 60_000 }),
  });
  it.each([
    [
      17,
      "idle 12 of 13 minutes",
      running(13, 12),
      "service",
      "idle for 12 min, treated as long-running",
    ],
    ["17b", "idle, but has run only 5 minutes", running(5, 4), "standard", "first run"],
    ["17c", "a long run idle only a minute", running(30, 1), "standard", "first run"],
    ["17d", "a long run that never went idle", running(30, null), "standard", "first run"],
  ])("row %s: %s", (_row, _name, entry, kind, why) => {
    expect(costOf(entry, null, QUICK_SECONDS, NOW)).toEqual({ class: kind, why });
  });

  it("an unparseable line is a standard job", () => {
    expect(cost("vp lint 'unclosed")).toMatchObject({ class: "standard" });
    expect(costOf({ label: "" }, null, QUICK_SECONDS)).toMatchObject({ class: "standard" });
  });

  it("a long line is judged by its full text, not the 200-character label", () => {
    const line = `cd /w; files=(${"packages/x/src/a.ts ".repeat(12)}); for f in "\${files[@]}"; do vp fmt --stdin-filepath="$f" < "$f"; done`;
    expect(line.length).toBeGreaterThan(200);
    expect(cost(line)).toEqual({ class: "quick", why: "1 file" });
  });
});
