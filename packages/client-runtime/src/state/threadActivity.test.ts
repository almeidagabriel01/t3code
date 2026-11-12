import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import {
  buildActivityEntries,
  countActivityBadge,
  firstValidTimestampMs,
  holdSidebarPriorityRank,
  isSidebarThreadWoke,
  markActivityRead,
  resolveSidebarPriorityRank,
  selectActivityClear,
  selectAgentsSection,
  selectProjectActivity,
  selectSidebarMarkReadTargets,
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
  const unread = shell("unread", { latestRun, lastVisitedAt: before });
  const readOnly = shell("readonly", { latestRun, lastVisitedAt: before });
  const quiet = shell("quiet");
  const working = shell("working", { runtime: { status: "running" } });
  const key = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const threads = [unread, readOnly, quiet, working];
  const canOperate = (thread: EnvironmentThreadShell) => thread.id !== "readonly";

  it("selects only operable unread rows as mark-read targets", () => {
    const targets = selectSidebarMarkReadTargets({
      threads,
      localLastVisitedAtByKey: {},
      canOperate,
    });
    expect(targets.map((thread) => thread.id)).toEqual(["unread"]);
    const woke = selectSidebarMarkReadTargets({
      threads: [quiet],
      localLastVisitedAtByKey: {},
      wokeAtByKey: new Map([[key(quiet), before]]),
      canOperate,
    });
    expect(woke).toHaveLength(0);
  });

  it("plans: marks operable unread read, releases quiet rows, keeps work and unwritable rows", () => {
    const plan = selectActivityClear({
      threads,
      localLastVisitedAtByKey: {},
      wokeAtByKey: new Map(),
      canOperate,
    });
    expect(plan.markRead.map((thread) => thread.id)).toEqual(["unread"]);
    expect(plan.releaseKeys).toHaveLength(2);
    expect(plan.releaseKeys).toEqual(["env:unread", "env:quiet"]);
  });

  it("rank resolves hold for an open decision and a local visit watermark", () => {
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
    const plan = { markRead: [unread, readOnly], releaseKeys: ["a", "b"] };
    const released: string[][] = [];
    const restored: string[] = [];
    await markActivityRead({
      plan,
      release: (keys) => released.push([...keys]),
      restore: (k) => restored.push(k),
      visit: async (thread) => (thread.id === "unread" ? "failed" : "visited"),
    });
    expect(released).toEqual([["a", "b"]]);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toContain("unread");
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
  ])("$name", ({ threads, needsYou, working, done }) => {
    const section = selectAgentsSection(build(threads));
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
