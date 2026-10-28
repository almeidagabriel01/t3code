import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRunningGroups, classifyRunningThread, summarizeRunning } from "./running.logic";

const env = "env-1" as EnvironmentId;
const runtime = (status: string) => ({ status }) as EnvironmentThreadShell["runtime"];

function shell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: env,
    id: "thread-1" as ThreadId,
    projectId: "project-a" as ProjectId,
    title: "Thread",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("classifyRunningThread", () => {
  it.each([
    ["an idle thread", shell(), null],
    ["a running thread", shell({ runtime: runtime("running") }), "running"],
    ["a queued thread", shell({ runtime: runtime("queued") }), "running"],
    ["a pending approval", shell({ hasPendingApprovals: true }), "attention"],
    ["a subagent question", shell({ pendingSubagentRequest: "user_input" }), "attention"],
    ["a guest request", shell({ pendingGuestMessageCount: 2 }), "attention"],
    [
      "an archived running thread",
      shell({ runtime: runtime("running"), archivedAt: "2026-10-02T00:00:00.000Z" }),
      null,
    ],
  ] as const)("classifies %s", (_name, input, expected) => {
    expect(classifyRunningThread(input)).toBe(expected);
  });

  it("counts a run parked at idle on background work as running", () => {
    const parked = shell({
      runtime: runtime("idle"),
      pendingBackgroundTasks: [{}] as unknown as EnvironmentThreadShell["pendingBackgroundTasks"],
    });
    expect(classifyRunningThread(parked)).toBe("running");
  });
});

describe("buildRunningGroups", () => {
  const projects = [
    { environmentId: env, id: "project-a" as ProjectId, title: "Zeta" },
    { environmentId: env, id: "project-b" as ProjectId, title: "Alpha" },
  ];

  it("groups busy threads by project, attention first, then in start order", () => {
    const shells = [
      shell({ id: "late" as ThreadId, runtime: runtime("running"), createdAt: "2026-10-03" }),
      shell({ id: "early" as ThreadId, runtime: runtime("running"), createdAt: "2026-10-01" }),
      shell({ id: "asks" as ThreadId, hasPendingUserInput: true, createdAt: "2026-10-05" }),
      shell({ id: "quiet" as ThreadId }),
      shell({
        id: "other" as ThreadId,
        projectId: "project-b" as ProjectId,
        runtime: runtime("running"),
      }),
    ];
    const groups = buildRunningGroups(shells, projects);
    expect(groups.map((group) => group.title)).toEqual(["Alpha", "Zeta"]);
    expect(groups[1]!.threads.map((thread) => thread.ref.threadId)).toEqual([
      "asks",
      "early",
      "late",
    ]);
    expect(groups[1]).toMatchObject({ running: 2, attention: 1 });
    expect(summarizeRunning(shells)).toEqual({ running: 3, attention: 1 });
  });
});
