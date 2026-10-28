import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import {
  collectAccountSessions,
  collectUsageSessions,
  groupSessionsByProject,
} from "@t3tools/client-runtime/state/usageSessions";

const env = EnvironmentId.make("env-a");
const instanceId = ProviderInstanceId.make("codex");
const now = Date.parse("2026-09-03T12:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const thread = (id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: env,
    projectId: ProjectId.make("p1"),
    providerInstanceId: instanceId,
    title: id,
    updatedAt: ago(5),
    ...overrides,
  });

const running = {
  status: "running",
  activeRunId: RunId.make("run-1"),
  providerInstanceId: instanceId,
  providerName: null,
  lastError: null,
  updatedAt: ago(1),
  activityStartedAt: ago(12),
} as const;

describe("collectAccountSessions", () => {
  it("merges every instance the account signs in as, across environments", () => {
    const other = ProviderInstanceId.make("codex-work");
    const envB = EnvironmentId.make("env-b");
    const sessions = collectAccountSessions({
      threads: [
        thread("a", { updatedAt: ago(5) }),
        thread("b", {
          environmentId: envB,
          providerInstanceId: other,
          modelSelection: { instanceId: other, model: "m" },
          updatedAt: ago(10),
        }),
        thread("unrelated", { environmentId: envB, updatedAt: ago(2) }),
      ],
      instances: [
        { environmentId: env, instanceId },
        { environmentId: envB, instanceId: other },
      ],
      now,
    });
    expect(sessions.map((s) => s.title)).toEqual(["a", "b"]);
  });
});

describe("collectUsageSessions", () => {
  it("orders waiting, working, then recent and times each from its own start", () => {
    const sessions = collectUsageSessions({
      threads: [
        thread("recent", { updatedAt: ago(20) }),
        thread("working", { runtime: running }),
        thread("waiting", { hasPendingApprovals: true, runtime: running }),
      ],
      instanceId,
      environmentIds: [env],
      now,
    });
    expect(sessions.map((s) => [s.title, s.state, s.elapsed])).toEqual([
      ["waiting", "waiting", "12m"],
      ["working", "working", "12m"],
      ["recent", "recent", "20m ago"],
    ]);
  });

  it("skips other instances and environments, stale idle, and archived threads", () => {
    const other = ProviderInstanceId.make("claude");
    const sessions = collectUsageSessions({
      threads: [
        thread("elsewhere", {
          providerInstanceId: other,
          modelSelection: { instanceId: other, model: "m" },
        }),
        thread("stale", { updatedAt: ago(180) }),
        thread("archived", { archivedAt: ago(1) }),
        thread("other-env", { environmentId: EnvironmentId.make("env-b") }),
        thread("kept"),
      ],
      instanceId,
      environmentIds: [env],
      now,
    });
    expect(sessions.map((s) => s.title)).toEqual(["kept"]);
  });
});

describe("groupSessionsByProject", () => {
  it("keeps the first-seen order of projects", () => {
    const sessions = collectUsageSessions({
      threads: [
        thread("a", { projectId: ProjectId.make("p2"), hasPendingUserInput: true }),
        thread("b"),
        thread("c", { projectId: ProjectId.make("p2") }),
      ],
      instanceId,
      environmentIds: [env],
      now,
    });
    expect(groupSessionsByProject(sessions).map((g) => g.sessions.map((s) => s.title))).toEqual([
      ["a", "c"],
      ["b"],
    ]);
  });
});
