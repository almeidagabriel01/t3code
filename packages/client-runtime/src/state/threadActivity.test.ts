import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  buildActivityEntries,
  countActivityBadge,
  firstValidTimestampMs,
  holdSidebarPriorityRank,
  isSidebarThreadWoke,
  countsInActivityBadge,
  markActivityRead,
  planActivityClear,
  planActivityMarkAllRead,
  resolveSidebarPriorityRank,
  selectAgentsSection,
  selectProjectActivity,
  type ActivityReadPlan,
} from "./threadActivity.ts";

const now = "2026-03-09T10:10:00.000Z";
const before = "2026-03-09T10:04:00.000Z";
const after = "2026-03-09T10:06:00.000Z";
const latestRun = { completedAt: "2026-03-09T10:05:00.000Z", status: "completed" };

const shell = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    createdAt: "2026-03-09T09:00:00.000Z",
    archivedAt: null,
    sideChatOf: null,
    lineage: { relationshipToParent: "none", parentThreadId: null },
    latestRun: null,
    runtime: null,
    lastVisitedAt: after,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const build = (threads: EnvironmentThreadShell[]) =>
  buildActivityEntries({
    threads,
    delegatedUnderParent: new Set(),
    localLastVisitedAtByKey: {},
    holds: new Map(),
    releases: new Set(),
    now,
  });

describe("buildActivityEntries", () => {
  it("groups needs-you, working, then unread, and leaves out threads that are not listed", () => {
    const entries = build([
      shell("unread", { latestRun, lastVisitedAt: before }),
      shell("working", { runtime: { status: "running" } }),
      shell("approval", { hasPendingApprovals: true }),
      shell("quiet"),
      shell("assistant:one", { hasPendingApprovals: true }),
      shell("subagent", {
        hasPendingApprovals: true,
        lineage: { relationshipToParent: "subagent", parentThreadId: "approval" },
      }),
      shell("side", { hasPendingApprovals: true, sideChatOf: "approval" }),
      shell("archived", { hasPendingApprovals: true, archivedAt: before }),
    ]);
    expect(entries.map((entry) => [entry.thread.id, entry.rank])).toEqual([
      ["approval", 0],
      ["working", 1],
      ["unread", 2],
    ]);
    expect(countActivityBadge(entries)).toBe(2);
  });
});

describe("isSidebarThreadWoke", () => {
  it.each([
    [null, undefined, false],
    ["not-a-date", undefined, false],
    [before, undefined, true],
    [before, "garbage", true],
    [after, before, true],
    [before, after, false],
  ] as const)("wokeAt %s visited %s -> %s", (wokeAt, visited, expected) => {
    expect(isSidebarThreadWoke(wokeAt, visited)).toBe(expected);
  });
});

describe("holdSidebarPriorityRank", () => {
  const base = { key: "k", settledOverride: null, holds: new Map([["k", null]]) } as const;
  it.each([
    ["keeps a real rank", { rank: 0 as const }, 0],
    ["holds a read row as unread", { rank: null }, 2],
    ["released drops it", { rank: null, released: true }, null],
    ["unheld stays off", { rank: null, holds: new Map() }, null],
    ["settled change ends the hold", { rank: null, settledOverride: "settled" as never }, null],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(holdSidebarPriorityRank({ ...base, ...overrides } as never)).toBe(expected);
  });
});

describe("firstValidTimestampMs", () => {
  it("skips null and unparsable candidates, else 0", () => {
    expect(firstValidTimestampMs(null, undefined, "nope", before)).toBe(Date.parse(before));
    expect(firstValidTimestampMs(null, "nope")).toBe(0);
  });
});

describe("read plan", () => {
  const at = (minute: number) => `2026-03-09T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const unseen = { lastVisitedAt: before };
  // Every row the badge counts, each arriving after the last visit (10:04).
  const counted = [
    shell("approval", { hasPendingApprovals: true, pendingRequest: { createdAt: at(7) } }),
    shell("input", { hasPendingUserInput: true, pendingUserInputAt: at(7) }),
    shell("subagent", { pendingSubagentRequest: "approval", pendingSubagentRequestAt: at(7) }),
    shell("guest", {
      pendingGuestMessageCount: 2,
      oldestPendingGuestMessageAt: at(1),
      latestPendingGuestMessageAt: at(7),
    }),
    shell("decision"),
    shell("unread", { latestRun, ...unseen }),
    // The machine that ran it is ahead of this device's clock (now is 10:10).
    shell("ahead", { latestRun: { completedAt: at(30), status: "completed" }, ...unseen }),
    shell("woke", { snoozedUntil: at(8), snoozedAt: at(0), ...unseen }),
    shell("finished-after-wake", {
      snoozedUntil: at(7),
      snoozedAt: at(0),
      latestRun: { completedAt: at(9), status: "completed" },
      ...unseen,
    }),
  ].map((thread) => (thread.lastVisitedAt === after ? { ...thread, ...unseen } : thread));
  const openDecisionAtByKey = new Map([["env:decision", at(7)]]);
  const entriesOf = (threads: EnvironmentThreadShell[]) =>
    buildActivityEntries({
      threads,
      delegatedUnderParent: new Set(),
      localLastVisitedAtByKey: {},
      holds: new Map(),
      releases: new Set(),
      now,
      openDecisionThreadKeys: new Set(openDecisionAtByKey.keys()),
      openDecisionAtByKey,
    });
  const visit = (threads: EnvironmentThreadShell[], plan: ActivityReadPlan) =>
    threads.map((thread) => {
      const visitedAt = plan.visits.find((entry) => entry.thread.id === thread.id)?.visitedAt;
      return visitedAt === undefined || Date.parse(visitedAt) < Date.parse(thread.lastVisitedAt!)
        ? thread
        : { ...thread, lastVisitedAt: visitedAt };
    });

  it("Mark all as read clears every row the badge counts, at each row's own time", () => {
    const entries = entriesOf(counted);
    expect(countActivityBadge(entries)).toBe(counted.length);
    const plan = planActivityMarkAllRead(entries, () => true, now);
    const after = entriesOf(visit(counted, plan));
    expect(countActivityBadge(after)).toBe(0);
    // Requests stay listed until answered or dismissed.
    expect(after.map((entry) => [entry.thread.id, entry.rank]).toSorted()).toEqual(
      ["approval", "decision", "guest", "input", "subagent"].map((id) => [id, 0]),
    );
  });

  it("a request older than the last visit is listed without counting", () => {
    const seen = shell("seen", { hasPendingUserInput: true, pendingUserInputAt: before });
    const entries = entriesOf([seen]);
    expect(entries.map((entry) => entry.rank)).toEqual([0]);
    expect(countActivityBadge(entries)).toBe(0);
  });

  it("an older server's request with no arrival time keeps counting, as before", () => {
    const guest = shell("guest", {
      pendingGuestMessageCount: 1,
      oldestPendingGuestMessageAt: at(1),
    });
    const plan = planActivityMarkAllRead(entriesOf([guest]), () => true, now);
    expect(countActivityBadge(entriesOf(visit([guest], plan)))).toBe(1);
  });

  it.each([
    ["needs you on a writable connection", 0, true, true, true],
    ["unread on a writable connection", 2, true, true, true],
    ["unread on a read-only connection shows without counting", 2, true, false, false],
    ["needs you on a read-only connection shows without counting", 0, true, false, false],
    ["already seen", 0, false, true, false],
    ["working", 1, false, true, false],
  ] as const)("badge: %s", (_name, rank, unread, operable, expected) => {
    expect(countsInActivityBadge({ rank, unread } as never, operable)).toBe(expected);
  });

  it("Clear read visits writable finished rows and releases every finished row it can clear", () => {
    const working = shell("working", { runtime: { status: "running" } });
    const readOnly = shell("readonly", { latestRun, ...unseen });
    const threads = [counted[0]!, counted[5]!, working, readOnly];
    const entries = entriesOf(threads);
    const canOperate = (thread: EnvironmentThreadShell) => thread.id !== "readonly";
    const plan = planActivityClear(entries, canOperate, now);
    expect(plan.visits.map((entry) => [entry.thread.id, entry.visitedAt])).toEqual([
      ["unread", latestRun.completedAt],
    ]);
    expect(plan.releaseKeys).toEqual(["env:unread"]);
    const one = planActivityClear(entries, canOperate, now, "env:readonly");
    expect(one.visits).toEqual([]);
    expect(
      planActivityMarkAllRead(entries, canOperate, now).visits.map((v) => v.thread.id),
    ).toEqual(["approval", "unread"]);
  });

  it("rank resolves hold for an open decision and a local visit watermark", () => {
    const quiet = shell("quiet");
    const unread = shell("unread", { latestRun, ...unseen });
    expect(resolveSidebarPriorityRank({ thread: quiet, wokeAt: null, hasOpenDecision: true })).toBe(
      0,
    );
    expect(
      resolveSidebarPriorityRank({
        thread: { ...unread, lastVisitedAt: undefined },
        wokeAt: null,
        localLastVisitedAt: after,
      }),
    ).toBe(null);
  });

  it("releases at once and restores only rows whose visit fails", async () => {
    const unread = shell("unread", { latestRun, ...unseen });
    const plan: ActivityReadPlan = {
      visits: [
        { key: "env:unread", thread: unread, visitedAt: now },
        { key: "env:other", thread: shell("other"), visitedAt: now },
      ],
      releaseKeys: ["env:unread", "env:other"],
    };
    const released: string[][] = [];
    const restored: string[] = [];
    await markActivityRead({
      plan,
      release: (keys) => released.push([...keys]),
      restore: (k) => restored.push(k),
      visit: async (thread) => (thread.id === "unread" ? "failed" : "visited"),
    });
    expect(released).toEqual([["env:unread", "env:other"]]);
    expect(restored).toEqual(["env:unread"]);
  });
});

describe("selectAgentsSection", () => {
  const run = (startedAt: string | null, completedAt: string | null = null) => ({
    startedAt,
    requestedAt: null,
    completedAt,
    status: "completed",
  });
  it.each([
    {
      name: "puts what needs the user first, then working, then unread, newest first",
      threads: [
        shell("w-old", {
          runtime: { status: "running" },
          latestRun: run("2026-03-09T09:10:00.000Z"),
        }),
        shell("w-new", {
          runtime: { status: "running" },
          latestRun: run("2026-03-09T09:50:00.000Z"),
        }),
        shell("w-none", { runtime: { status: "running" }, createdAt: "2026-03-09T09:20:00.000Z" }),
        shell("d-old", {
          latestRun: run(null, "2026-03-09T10:01:00.000Z"),
          lastVisitedAt: "2026-03-09T09:00:00.000Z",
        }),
        shell("d-new", { latestRun: run(null, "2026-03-09T10:05:00.000Z"), lastVisitedAt: before }),
        shell("approval", { hasPendingApprovals: true, updatedAt: "2026-03-09T09:00:00.000Z" }),
        shell("input", {
          hasPendingUserInput: true,
          runtime: { status: "running" },
          updatedAt: "2026-03-09T11:00:00.000Z",
        }),
        shell("guest", { pendingGuestMessageCount: 1, updatedAt: "2026-03-09T10:00:00.000Z" }),
        shell("quiet"),
      ],
      needsYou: ["input", "guest", "approval"],
      working: ["w-new", "w-none", "w-old"],
      done: ["d-new", "d-old"],
    },
    {
      name: "is empty when nothing runs or finished",
      threads: [shell("quiet")],
      needsYou: [],
      working: [],
      done: [],
    },
    {
      name: "leaves out threads an assistant owns: its tasks and its chats' children",
      threads: [
        shell("task", { hasPendingUserInput: true }),
        shell("task-done", {
          latestRun: run(null, "2026-03-09T10:05:00.000Z"),
          lastVisitedAt: before,
        }),
        shell("fork", {
          runtime: { status: "running" },
          lineage: { relationshipToParent: "fork", parentThreadId: "assistant:qa:1" },
        }),
        shell("delegated", {
          runtime: { status: "running" },
          delegatedFrom: { environmentId: "env-2", threadId: "assistant:qa:g-x", title: "QA" },
        }),
        shell("mine", { runtime: { status: "running" } }),
      ],
      assistantTaskKeys: new Set(["env:task", "env:task-done"]),
      needsYou: [],
      working: ["mine"],
      done: [],
    },
  ])("$name", ({ threads, needsYou, working, done, ...rest }) => {
    const assistantTaskKeys = "assistantTaskKeys" in rest ? rest.assistantTaskKeys : undefined;
    const section = selectAgentsSection(build(threads), assistantTaskKeys);
    expect(section.needsYou.map((entry) => entry.thread.id)).toEqual(needsYou);
    expect(section.working.map((entry) => entry.thread.id)).toEqual(working);
    expect(section.done.map((entry) => entry.thread.id)).toEqual(done);
  });
});

describe("selectProjectActivity", () => {
  const ended = (status: string, completedAt: string) => ({
    startedAt: null,
    requestedAt: null,
    completedAt,
    status,
  });
  const unseen = { lastVisitedAt: "2026-03-09T08:00:00.000Z" };
  const threads = [
    shell("done", { ...unseen, latestRun: ended("completed", "2026-03-09T09:10:00.000Z") }),
    shell("failed", { ...unseen, latestRun: ended("failed", "2026-03-09T09:40:00.000Z") }),
    shell("stopped", { ...unseen, latestRun: ended("interrupted", "2026-03-09T09:20:00.000Z") }),
    shell("asks", { hasPendingApprovals: true, updatedAt: "2026-03-09T09:30:00.000Z" }),
    shell("working", { runtime: { status: "running" } }),
    shell("seen", { latestRun: ended("completed", "2026-03-09T07:00:00.000Z") }),
    shell("other-project", { ...unseen, projectId: ProjectId.make("other"), latestRun }),
    shell("other-env", {
      ...unseen,
      environmentId: EnvironmentId.make("env-2"),
      latestRun,
    }),
    shell("assistant:helper", { ...unseen, latestRun }),
  ];

  it("keeps the project's waiting and ended runs, newest first, with what happened", () => {
    expect(
      selectProjectActivity(build(threads), { environmentId: "env", projectId: "project" }).map(
        (entry) => [entry.thread.id, entry.outcome],
      ),
    ).toEqual([
      ["failed", "failed"],
      ["asks", "needs-you"],
      ["stopped", "interrupted"],
      ["done", "finished"],
    ]);
  });

  it("is empty for a project with nothing to show", () => {
    expect(
      selectProjectActivity(build(threads), { environmentId: "env", projectId: "none" }),
    ).toEqual([]);
  });
});
