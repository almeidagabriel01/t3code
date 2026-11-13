import {
  DEFAULT_ASSISTANT_AUTONOMY,
  DEFAULT_AUTONOMY_SETTINGS,
  type AssistantAutonomy,
  type AutonomyWatch,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  candidatesFor,
  ruleEnabled,
  watchMatches,
  wakeMessage,
  type AutonomySignal,
} from "./autonomyRules.ts";

const awake = (patch: Partial<AssistantAutonomy> = {}): AssistantAutonomy => ({
  ...DEFAULT_ASSISTANT_AUTONOMY,
  mode: "reply-and-notify",
  ...patch,
});
const signal = (patch: Partial<AutonomySignal> = {}): AutonomySignal => ({
  event: "run_failed",
  key: "run:1",
  threadId: "t1",
  projectId: "p1",
  prNumber: null,
  summary: "A run failed.",
  ...patch,
});
const watch = (patch: Partial<AutonomyWatch> = {}): AutonomyWatch =>
  ({
    id: "w1",
    assistantId: "a1",
    title: "PR 7",
    filter: { event: "pr_checks_passed", prNumber: 7 },
    instruction: "",
    oneShot: true,
    expiresAt: null,
    enabled: true,
    triggerCount: 0,
    lastTriggeredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  }) as AutonomyWatch;
const settings = DEFAULT_AUTONOMY_SETTINGS;
const wakes = (input: {
  signal: AutonomySignal;
  autonomy: AssistantAutonomy;
  watches?: AutonomyWatch[];
  settings?: typeof settings;
}) =>
  candidatesFor({
    signal: input.signal,
    assistants: [{ id: "a1", autonomy: input.autonomy }],
    watches: input.watches ?? [],
    settings: input.settings ?? settings,
    nowMs: 1_000,
  }).length;

it.each([
  { name: "reply-only never wakes", autonomy: awake({ mode: "reply-only" }), count: 0 },
  { name: "reply-and-notify wakes", autonomy: awake(), count: 1 },
  { name: "project scope includes it", autonomy: awake({ projectIds: ["p1" as never] }), count: 1 },
  { name: "project scope excludes it", autonomy: awake({ projectIds: ["p2" as never] }), count: 0 },
  { name: "explicit rule list without the rule", autonomy: awake({ rules: ["stuck"] }), count: 0 },
  { name: "explicit rule list with the rule", autonomy: awake({ rules: ["runFailed"] }), count: 1 },
])("run_failed: $name", ({ autonomy, count }) => {
  expect(wakes({ signal: signal(), autonomy })).toBe(count);
});

it("the most specific setting wins over the global toggle", () => {
  const off = { ...settings, rules: { ...settings.rules, runFailed: false } };
  expect(ruleEnabled("runFailed", awake(), off)).toBe(false);
  expect(ruleEnabled("runFailed", awake({ rules: ["runFailed"] }), off)).toBe(true);
  expect(ruleEnabled("runFailed", awake({ rules: [] }), settings)).toBe(false);
});

it.each([
  {
    name: "matches its event and PR",
    w: watch(),
    s: signal({ event: "pr_checks_passed", prNumber: 7 }),
    ok: true,
  },
  {
    name: "another PR",
    w: watch(),
    s: signal({ event: "pr_checks_passed", prNumber: 8 }),
    ok: false,
  },
  {
    name: "another event",
    w: watch(),
    s: signal({ event: "pr_checks_failed", prNumber: 7 }),
    ok: false,
  },
  {
    name: "paused",
    w: watch({ enabled: false }),
    s: signal({ event: "pr_checks_passed", prNumber: 7 }),
    ok: false,
  },
  {
    name: "expired",
    w: watch({ expiresAt: "1970-01-01T00:00:00.000Z" }),
    s: signal({ event: "pr_checks_passed", prNumber: 7 }),
    ok: false,
  },
  {
    name: "thread filter",
    w: watch({ filter: { event: "run_finished", threadId: "t9" as never } }),
    s: signal({ event: "run_finished" }),
    ok: false,
  },
])("watch $name -> $ok", ({ w, s, ok }) => {
  expect(watchMatches(w, s, 1_000)).toBe(ok);
});

it("a watch wakes its assistant in either mode; watchesOnly keeps the rules out", () => {
  const s = signal({ event: "pr_checks_passed", prNumber: 7 });
  expect(wakes({ signal: s, autonomy: awake(), watches: [watch()] })).toBe(1);
  expect(wakes({ signal: s, autonomy: awake({ mode: "reply-only" }), watches: [watch()] })).toBe(1);
  // Another assistant's watch, or one whose assistant is gone, wakes nobody here.
  expect(wakes({ signal: s, autonomy: awake(), watches: [watch({ assistantId: "ghost" })] })).toBe(
    0,
  );
  const failed = signal();
  const both = {
    signal: failed,
    assistants: [{ id: "a1", autonomy: awake() }],
    settings,
    nowMs: 1,
  };
  const onFail = watch({ filter: { event: "run_failed" } });
  expect(candidatesFor({ ...both, watches: [onFail] })).toHaveLength(2);
  expect(
    candidatesFor({ ...both, watches: [onFail], watchesOnly: true }).map(
      (c) => "watch" in c.source,
    ),
  ).toEqual([true]);
});

it("the wake message carries the context and ends with the do-not-change instruction", () => {
  const text = wakeMessage(
    signal(),
    { watch: watch({ instruction: "Tell me if it is flaky" }) },
    {
      threadTitle: "Fix login",
      threadLink: "[Fix login](t3-thread://x)",
      projectName: "acme/app",
      lastAssistantMessage: "x".repeat(900),
      diffStat: "+3 -1",
    },
  );
  expect(text).toContain("Watch: PR 7");
  expect(text).toContain("Thread: [Fix login](t3-thread://x)");
  expect(text).toContain("Project: acme/app");
  expect(text).toContain("Diff: +3 -1");
  expect(text).toContain("Instruction from the user: Tell me if it is flaky");
  expect(text).toContain("x".repeat(600) + "…");
  expect(text.endsWith("Do not change anything.")).toBe(true);
});
