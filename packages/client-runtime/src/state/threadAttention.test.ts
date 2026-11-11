import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  activeSubagentChildrenByParent,
  hasSidebarNotification,
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
} from "./threadAttention.ts";

const environmentId = EnvironmentId.make("environment-local");
const parentId = ThreadId.make("parent");

function child(id: string, status: "running" | "completed" | "failed" | "idle") {
  return presentThreadShell(environmentId, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    latestRunId: RunId.make(`run-${id}`),
    status,
    lineage: { parentThreadId: parentId, relationshipToParent: "subagent", rootThreadId: parentId },
  });
}

describe("activeSubagentChildrenByParent", () => {
  it("lists only non-terminal subagent children under their parent", () => {
    const byParent = activeSubagentChildrenByParent([
      child("a", "running"),
      child("b", "completed"),
      child("c", "failed"),
      child("d", "idle"),
    ]);
    const children = byParent.get(scopedThreadKey(scopeThreadRef(environmentId, parentId)));
    expect(children?.map((thread) => thread.id)).toEqual(["a"]);
  });

  it("lists a native child that has no run of its own while its activity is live", () => {
    const native = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      id: ThreadId.make("native"),
      latestRunId: null,
      activeProviderThreadId: null,
      status: "idle",
      activityRunStatus: "running",
      lineage: {
        parentThreadId: parentId,
        relationshipToParent: "subagent",
        rootThreadId: parentId,
      },
    });
    const byParent = activeSubagentChildrenByParent([native]);
    expect(
      byParent.get(scopedThreadKey(scopeThreadRef(environmentId, parentId)))?.map((t) => t.id),
    ).toEqual(["native"]);
  });

  const unawaited = { taskId: "bg", description: "npm ci", kind: "command" } as const;
  const awaited = { ...unawaited, awaited: true } as const;
  const held = (
    id: string,
    status: "completed" | "failed",
    tasks: ReadonlyArray<typeof awaited | typeof unawaited>,
    parent = parentId,
  ) =>
    presentThreadShell(environmentId, {
      ...v2ThreadShell,
      id: ThreadId.make(id),
      latestRunId: RunId.make(`run-${id}`),
      status,
      pendingBackgroundTasks: tasks,
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parentId },
    });

  // The parent's subagent record stays running in each listed case, so Lineage counts it.
  it.each([
    ["a finished run awaiting a background command", [held("x", "completed", [awaited])], ["x"]],
    [
      "a finished run with only unawaited background work",
      [held("x", "completed", [unawaited])],
      [],
    ],
    ["a failed run with awaited background work", [held("x", "failed", [awaited])], []],
    [
      "a finished run held by its own live subagent",
      [
        held("x", "completed", []),
        held("y", "completed", [], ThreadId.make("x")),
        held("z", "completed", [awaited], ThreadId.make("y")),
      ],
      ["x"],
    ],
    [
      "a finished run whose own subagents all finished",
      [held("x", "completed", []), held("y", "completed", [], ThreadId.make("x"))],
      [],
    ],
  ] as const)("lists a child with %s as the parent's record does", (_name, threads, expected) => {
    const byParent = activeSubagentChildrenByParent(threads);
    expect(
      (byParent.get(scopedThreadKey(scopeThreadRef(environmentId, parentId))) ?? []).map(
        (thread) => thread.id,
      ),
    ).toEqual(expected);
  });

  it("drops a parent once every child is terminal", () => {
    expect(activeSubagentChildrenByParent([child("b", "completed")]).size).toBe(0);
  });
});

describe("resolveSidebarThreadStatus for runless threads", () => {
  const runless = {
    ...v2ThreadShell,
    latestRunId: null,
    activeRunId: null,
    activityRunStatus: null,
    status: "idle" as const,
  };

  it.each([
    ["an imported thread that never ran", {}, "ready"],
    [
      "an idle thread held open by awaited background work",
      {
        pendingBackgroundTasks: [
          { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
        ],
      },
      "waiting",
    ],
  ] as const)("reports %s as %s", (_name, overrides, expected) => {
    const shell = presentThreadShell(environmentId, {
      ...runless,
      activeProviderThreadId: v2ThreadShell.activeProviderThreadId ?? ("provider-thread" as never),
      ...overrides,
    } as never);
    expect(resolveSidebarThreadStatus(shell)).toBe(expected);
  });
});

describe("thread notification", () => {
  const completed = (lastVisitedAt: string | null) => ({
    ...child("n", "completed"),
    latestRun: {
      ...child("n", "completed").latestRun!,
      completedAt: "2026-06-20T01:00:00.000Z",
    },
    lastVisitedAt,
  });

  it("treats a never-visited completed thread as unseen", () => {
    const thread = completed(null);
    expect(hasUnseenCompletion(thread)).toBe(true);
    expect(hasSidebarNotification(thread)).toBe(true);
  });

  it("clears once visited after completion, but a pending approval still notifies", () => {
    const thread = completed("2026-06-20T02:00:00.000Z");
    expect(hasSidebarNotification(thread)).toBe(false);
    expect(hasSidebarNotification({ ...thread, hasPendingApprovals: true })).toBe(true);
    expect(hasSidebarNotification({ ...thread, hasOpenDecision: true })).toBe(true);
  });
});
