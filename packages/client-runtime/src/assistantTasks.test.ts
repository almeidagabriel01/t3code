import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type AssistantId,
  type AssistantTask,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_TASK_FACE,
  assistantTaskRows,
  assistantTaskState,
  canDismissAssistantTask,
  usageLimitLabel,
} from "./assistantTasks.ts";
import { presentThreadShell } from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-local");
const at = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");

const shell = (overrides: Record<string, unknown>) =>
  presentThreadShell(environmentId, { ...v2ThreadShell, ...overrides } as typeof v2ThreadShell);

const runningFields = {
  latestRunId: RunId.make("run-1"),
  activeRunId: RunId.make("run-1"),
  activityRunStatus: "running",
  activityRunStartedAt: at,
  status: "running",
};
const running = shell(runningFields);
const waiting = shell({
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make("r1"),
    kind: "command_approval",
    createdAt: at,
  },
});
const failed = shell({ latestRunId: RunId.make("run-1"), status: "failed" });
const limited = shell({
  latestRunId: RunId.make("run-1"),
  status: "failed",
  lastErrorClass: "usage_limit",
});
const done = shell({});

const task = (threadId: string, createdAt: string): AssistantTask => ({
  threadId: threadId as ThreadId,
  assistantId: "jarvis" as AssistantId,
  projectId: "p1" as ProjectId,
  title: `Task ${threadId}`,
  createdAt,
});

describe("assistantTaskState", () => {
  it.each([
    ["running", running],
    ["waiting", waiting],
    ["failed", failed],
    ["usage_limited", limited],
    ["done", done],
  ] as const)("a thread that is %s reads as %s", (state, thread) => {
    expect(assistantTaskState(thread)).toBe(state);
    expect(ASSISTANT_TASK_FACE[state]).toBeDefined();
    expect(canDismissAssistantTask(state)).toBe(state !== "running" && state !== "waiting");
  });
});

describe("usageLimitLabel", () => {
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  it.each([
    ["2026-11-14T15:30:00.000Z", "Limit until <2026-11-14T15:30:00.000Z>"],
    ["2026-11-14T11:00:00.000Z", null],
    [null, null],
    ["not a date", null],
  ])("reads %s as %s", (resetAt, label) => {
    expect(usageLimitLabel(resetAt, now, (iso) => `<${iso}>`)).toBe(label);
  });
});

describe("assistantTaskRows", () => {
  const shells = new Map<string, ReturnType<typeof shell>>([
    ["done-old", done],
    ["running-a", running],
    ["waiting-a", waiting],
    ["failed-a", failed],
    ["limited-a", limited],
    ["done-new", done],
    ["archived-done", shell({ archivedAt: at })],
    ["archived-running", shell({ ...runningFields, archivedAt: at })],
  ]);
  const tasks = [
    task("done-old", "2026-11-01T00:00:00.000Z"),
    task("running-a", "2026-11-02T00:00:00.000Z"),
    task("waiting-a", "2026-11-03T00:00:00.000Z"),
    task("failed-a", "2026-11-04T00:00:00.000Z"),
    task("limited-a", "2026-11-01T00:00:00.000Z"),
    task("done-new", "2026-11-05T00:00:00.000Z"),
    task("deleted", "2026-11-05T00:00:00.000Z"),
    task("archived-done", "2026-11-05T00:00:00.000Z"),
    task("archived-running", "2026-11-06T00:00:00.000Z"),
  ];

  it("orders waiting, running, usage-limited, failed, done, newest first, and drops what has no thread", () => {
    const rows = assistantTaskRows(tasks, (threadId) => shells.get(threadId));
    expect(rows.map((row) => row.task.threadId)).toEqual([
      "waiting-a",
      "archived-running",
      "running-a",
      "limited-a",
      "failed-a",
      "done-new",
      "done-old",
    ]);
  });

  it("hides dismissed tasks and null reads as not dismissed", () => {
    const rows = assistantTaskRows(
      [
        {
          ...task("done-new", "2026-11-05T00:00:00.000Z"),
          dismissedAt: "2026-11-06T00:00:00.000Z",
        },
        { ...task("done-old", "2026-11-01T00:00:00.000Z"), dismissedAt: null },
      ],
      (threadId) => shells.get(threadId),
    );
    expect(rows.map((row) => row.task.threadId)).toEqual(["done-old"]);
  });

  it("lists nothing for no tasks", () => {
    expect(assistantTaskRows([], () => undefined)).toEqual([]);
  });
});
