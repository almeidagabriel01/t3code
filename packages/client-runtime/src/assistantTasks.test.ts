import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  type AssistantId,
  type AssistantTask,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { taskEventHeadline } from "@t3tools/shared/assistantTaskEvents";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSISTANT_TASK_FACE,
  assistantSectionThreadKeys,
  assistantTaskRows,
  assistantTaskState,
  canDismissAssistantTask,
  assistantReplyText,
  taskEventActivity,
  taskEventActivitySegments,
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

describe("taskEventActivitySegments", () => {
  it.each([
    [
      "both present",
      { title: "Fix login", label: "Finished", project: "Payments" },
      [
        { kind: "title", text: "Fix login", separated: false },
        { kind: "label", text: "Finished", separated: true },
        { kind: "project", text: "Payments", separated: true },
      ],
    ],
    [
      "no title",
      { title: " ", label: "Finished", project: "Payments" },
      [
        { kind: "label", text: "Finished", separated: false },
        { kind: "project", text: "Payments", separated: true },
      ],
    ],
    [
      "no project",
      { title: "Fix login", label: "Finished", project: "" },
      [
        { kind: "title", text: "Fix login", separated: false },
        { kind: "label", text: "Finished", separated: true },
      ],
    ],
    [
      "neither",
      { title: "", label: "Finished", project: null },
      [{ kind: "label", text: "Finished", separated: false }],
    ],
  ] as const)("%s", (_name, parts, expected) => {
    expect(taskEventActivitySegments(parts)).toEqual(expected);
  });
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
  const settled = (settledAt: string) =>
    ({ ...done, settledOverride: "settled", settledAt }) as typeof done;
  const shells = new Map<string, ReturnType<typeof shell>>([
    ["running-a", running],
    ["waiting-a", waiting],
    ["done-unseen", done],
    ["settled-old", settled("2026-11-01T00:00:00.000Z")],
    ["settled-new", settled("2026-11-05T00:00:00.000Z")],
    ["archived-running", shell({ ...runningFields, archivedAt: at })],
  ]);
  const tasks = [
    task("running-a", "2026-11-02T00:00:00.000Z"),
    task("waiting-a", "2026-11-03T00:00:00.000Z"),
    task("done-unseen", "2026-11-04T00:00:00.000Z"),
    task("settled-old", "2026-11-01T00:00:00.000Z"),
    task("settled-new", "2026-11-05T00:00:00.000Z"),
    task("deleted", "2026-11-05T00:00:00.000Z"),
    task("archived-running", "2026-11-06T00:00:00.000Z"),
    { ...task("waiting-a", "2026-11-03T00:00:00.000Z"), dismissedAt: null },
  ];
  const ids = (rows: ReadonlyArray<{ readonly task: AssistantTask }>) =>
    rows.map((row) => row.task.threadId);

  it("splits open and settled as a project does, ordering open rows with the caller's sort", () => {
    const sorted: string[][] = [];
    const rows = assistantTaskRows(
      tasks,
      (threadId) => shells.get(threadId),
      (open) => {
        sorted.push(open.map((s) => [...shells].find(([, v]) => v === s)![0]));
        return open.toReversed();
      },
      { now: "2026-11-12T00:00:00.000Z" },
    );
    // A finished thread stays open until the server settles it; archived and deleted ones leave.
    expect(sorted).toEqual([["running-a", "waiting-a", "done-unseen"]]);
    expect(ids(rows.open)).toEqual(["done-unseen", "waiting-a", "running-a"]);
    expect(ids(rows.settled)).toEqual(["settled-new", "settled-old"]);
    expect(rows.open.map((row) => row.state)).toEqual(["done", "waiting", "running"]);
  });

  it("puts pinned and snoozed tasks in their own sections, as a project does", () => {
    const pinned = (key: string) => ({ ...running, pinnedAt: at.toString(), pinOrderKey: key });
    const snoozed = (until: string) => ({ ...done, snoozedAt: at.toString(), snoozedUntil: until });
    const byId = new Map<string, ReturnType<typeof shell>>([
      ["pin-b", pinned("b")],
      ["pin-a", pinned("a")],
      ["open", running],
      ["snooze-late", snoozed("2099-01-02T00:00:00.000Z")],
      ["snooze-soon", snoozed("2099-01-01T00:00:00.000Z")],
      ["snooze-over", snoozed("2000-01-01T00:00:00.000Z")],
      ["pinned-settled", { ...settled("2026-11-05T00:00:00.000Z"), pinnedAt: at.toString() }],
    ]);
    const rows = assistantTaskRows(
      [...byId.keys()].map((id) => task(id, "2026-11-02T00:00:00.000Z")),
      (threadId) => byId.get(threadId),
      (open) => open,
      { now: "2026-11-12T00:00:00.000Z" },
    );
    expect(ids(rows.pinned)).toEqual(["pin-a", "pin-b"]);
    // A snooze past its wake time is over; settlement wins over a stale pin.
    expect(ids(rows.open)).toEqual(["open", "snooze-over"]);
    expect(ids(rows.snoozed)).toEqual(["snooze-soon", "snooze-late"]);
    expect(ids(rows.settled)).toEqual(["pinned-settled"]);
  });

  it("hides dismissed tasks and lists nothing for no tasks", () => {
    const rows = assistantTaskRows(
      [{ ...task("running-a", "2026-11-05T00:00:00.000Z"), dismissedAt: at.toString() }],
      (threadId) => shells.get(threadId),
      (open) => open,
      { now: "2026-11-12T00:00:00.000Z" },
    );
    expect(rows).toEqual({ pinned: [], open: [], snoozed: [], settled: [] });
    expect(
      assistantTaskRows(
        [],
        () => undefined,
        (open) => open,
        { now: "2026-11-12T00:00:00.000Z" },
      ),
    ).toEqual({ pinned: [], open: [], snoozed: [], settled: [] });
  });
});

describe("assistantSectionThreadKeys", () => {
  const rowsOf = (...ids: string[]) =>
    ids.map((id) => ({ shell: { environmentId: "env", id } })) as never;
  const sections = {
    pinned: rowsOf("pin"),
    open: rowsOf("open"),
    snoozed: rowsOf("snoozed"),
    settled: rowsOf("settled"),
  };

  it.each([
    {
      name: "an unfolded assistant numbers its chat, tasks in shelf order, then its subagents",
      row: { folded: false, snoozedOpen: true, settledOpen: true },
      keys: ["env:chat", "env:pin", "env:open", "env:snoozed", "env:settled", "env:child"],
    },
    {
      name: "closed shelves hide their rows from the numbering",
      row: { folded: false, snoozedOpen: false, settledOpen: false },
      keys: ["env:chat", "env:pin", "env:open", "env:child"],
    },
    {
      name: "a folded assistant numbers only its chat",
      row: { folded: true, snoozedOpen: true, settledOpen: true },
      keys: ["env:chat"],
    },
  ])("$name", ({ row, keys }) => {
    expect(
      assistantSectionThreadKeys([
        { chatKey: "env:chat", sections, subagentKeys: ["env:child"], ...row },
        {
          chatKey: null,
          sections: { ...sections, open: [] },
          subagentKeys: [],
          folded: true,
          snoozedOpen: false,
          settledOpen: false,
        },
      ]),
    ).toEqual(keys);
  });
});

describe("assistantReplyText", () => {
  it.each([
    ["NO_REPLY", false, null],
    ["`NO_REPLY`.", false, null],
    ["Task X failed in CI.\n\nNO_REPLY", false, "Task X failed in CI."],
    ["The build broke.", false, "The build broke."],
    // While streaming, a reply that may still turn into the token is held back.
    ["NO_", true, null],
    ["Task X failed in CI.\n\nNO_REP", true, "Task X failed in CI."],
    ["No problem", true, "No problem"],
    ["", true, ""],
  ])("%j (streaming %s) → %j", (text, streaming, shown) => {
    expect(assistantReplyText(text, streaming)).toBe(shown);
  });
});

describe("taskEventActivity", () => {
  const task = "mcp:launch:task" as ThreadId;

  it("reads a task event into one line with the state the event told", () => {
    const text = `${taskEventHeadline({ title: "Add retry", threadId: task, status: "failed" })}\n\nIts last message:\nTests fail.`;
    expect(taskEventActivity({ id: "assistant-task:r1", text, senderThreadId: task })).toEqual({
      threadId: task,
      title: "Add retry",
      status: "failed",
      label: "Failed",
    });
  });

  it("falls back to the task thread's title when the headline is not T3's", () => {
    expect(
      taskEventActivity({ id: "assistant-task:r1", text: "?", senderThreadId: task }, "Live title"),
    ).toEqual({ threadId: task, title: "Live title", status: null, label: "Updated" });
  });

  it("leaves every other message alone", () => {
    expect(taskEventActivity({ id: "m1", text: "hi", senderThreadId: task })).toBeNull();
  });
});
