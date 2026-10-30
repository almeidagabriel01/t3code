import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { buildActivityEntries, countActivityBadge } from "./activity.logic";

const env = EnvironmentId.make("environment-local");
const seen = "2026-03-09T10:06:00.000Z";
const unseen = "2026-03-09T10:04:00.000Z";
const now = "2026-03-09T10:10:00.000Z";
const completedRun = {
  runId: RunId.make("run-1"),
  status: "completed" as const,
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

const thread = (id: string, overrides: ThreadFixtureOverrides = {}) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: env,
    runtime: null,
    latestRun: completedRun,
    lastVisitedAt: seen,
    createdAt: "2026-03-09T09:00:00.000Z",
    ...overrides,
  });
const keyOf = (row: ReturnType<typeof thread>) =>
  scopedThreadKey(scopeThreadRef(row.environmentId, row.id));

const build = (
  threads: ReturnType<typeof thread>[],
  extra: Partial<Parameters<typeof buildActivityEntries>[0]> = {},
) =>
  buildActivityEntries({
    threads: threads as never,
    delegatedUnderParent: new Set(),
    localLastVisitedAtByKey: {},
    holds: new Map(),
    releases: new Set(),
    now,
    ...extra,
  });

describe("buildActivityEntries", () => {
  it("lists what needs the user, then unread, and drops finished and read threads", () => {
    const needs = thread("needs", { hasPendingApprovals: true });
    const unread = thread("unread", { lastVisitedAt: unseen });
    const read = thread("read");
    const entries = build([read, unread, needs]);
    expect(entries.map((entry) => [entry.thread.id, entry.rank])).toEqual([
      ["needs", 0],
      ["unread", 2],
    ]);
    expect(countActivityBadge(entries)).toBe(2);
  });

  it("ranks a thread with an open decision as needing the user, even finished or working", () => {
    const finished = thread("finished");
    const working = thread("working", {
      runtime: { status: "running" } as never,
    });
    const quiet = thread("quiet");
    const entries = build([quiet, finished, working], {
      openDecisionThreadKeys: new Set([keyOf(finished), keyOf(working)]),
    });
    expect(entries.map((entry) => [entry.thread.id, entry.rank])).toEqual([
      ["finished", 0],
      ["working", 0],
    ]);
    expect(countActivityBadge(entries)).toBe(2);
  });

  it("keeps a thread read while the page is open, until it is released", () => {
    const row = thread("read");
    const holds = new Map([[keyOf(row), row.settledOverride]]);
    expect(build([row], { holds }).map((entry) => entry.rank)).toEqual([2]);
    expect(build([row], { holds, releases: new Set([keyOf(row)]) })).toEqual([]);
  });

  it("hides side chats, archived and snoozed threads", () => {
    const hidden = [
      thread("side", { sideChatOf: ThreadId.make("parent"), lastVisitedAt: unseen }),
      thread("archived", { archivedAt: unseen, lastVisitedAt: unseen }),
      thread("snoozed", {
        snoozedAt: unseen,
        snoozedUntil: "2026-03-09T12:00:00.000Z",
        lastVisitedAt: unseen,
      }),
    ];
    expect(build(hidden)).toEqual([]);
  });
});
