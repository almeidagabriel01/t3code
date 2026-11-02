import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentThreadShell } from "./models.ts";
import { buildActivityEntries, countActivityBadge } from "./threadActivity.ts";

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
