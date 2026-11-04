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
