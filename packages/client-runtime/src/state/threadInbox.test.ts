import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { sortActiveThreadsByOrderKey } from "./threadSort.ts";
import {
  createInboxReturnTracker,
  isThreadRunUserStarted,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(sortInboxThreadsByReturn([a, b], tracker.returnedAt).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("isThreadRunUserStarted", () => {
  const run = (requestedAt: string | null) => ({
    runId: RunId.make("run"),
    status: "running" as const,
    requestedAt,
    startedAt: requestedAt,
    completedAt: null,
    assistantMessageId: null,
  });
  it("is true only when your latest message started the latest run", () => {
    const sent = "2026-06-01T05:00:00.000Z";
    expect(
      isThreadRunUserStarted({ latestUserAuthoredMessageAt: sent, latestRun: run(sent) }),
    ).toBe(true);
    expect(
      isThreadRunUserStarted({
        latestUserAuthoredMessageAt: sent,
        latestRun: run("2026-06-01T06:00:00.000Z"),
      }),
    ).toBe(false);
    expect(isThreadRunUserStarted({ latestRun: run(sent) })).toBe(false);
    expect(isThreadRunUserStarted({ latestUserAuthoredMessageAt: sent, latestRun: null })).toBe(
      false,
    );
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("sortInboxThreadsByReturn: a message you just sent", () => {
  const at = (hour: number) => `2026-06-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const base = { ...thread("x", false), createdAt: at(0) };
  const run = (status: "running" | "waiting" | "completed" | "failed", requested: number) => ({
    runId: RunId.make(`run:${requested}`),
    status,
    requestedAt: at(requested),
    startedAt: at(requested),
    completedAt: status === "completed" || status === "failed" ? at(requested + 1) : null,
    assistantMessageId: null,
  });
  const idle = {
    ...base,
    id: ThreadId.make("idle"),
    latestRun: run("completed", 6),
    lastVisitedAt: at(9),
  };
  const { runtime: running } = thread("running", true);

  it.each([
    {
      name: "sent into a run waiting on a background command",
      subject: { latestRun: run("waiting", 2), latestUserAuthoredMessageAt: at(10) },
      top: "subject",
    },
    {
      name: "sent into a running run",
      subject: { latestRun: run("running", 2), latestUserAuthoredMessageAt: at(10) },
      top: "subject",
    },
    {
      name: "finished unread after the idle thread",
      subject: { latestRun: run("completed", 8), latestUserAuthoredMessageAt: at(8) },
      top: "subject",
    },
    {
      name: "failed after the idle thread",
      subject: { latestRun: run("failed", 8), latestUserAuthoredMessageAt: null },
      top: "subject",
    },
    {
      name: "needs approval, nothing newer than the idle thread",
      subject: {
        latestRun: run("waiting", 2),
        hasPendingApprovals: true,
        latestUserAuthoredMessageAt: at(3),
      },
      top: "subject",
    },
    {
      name: "an agent still running since before the idle thread finished",
      subject: {
        latestRun: run("running", 2),
        runtime: running,
        latestUserAuthoredMessageAt: null,
      },
      top: "subject",
    },
    {
      name: "idle thread stays above an older waiting run with no message",
      subject: { latestRun: run("waiting", 2), latestUserAuthoredMessageAt: null },
      top: "idle",
    },
  ])("$name", ({ subject, top }) => {
    const entry = { ...base, id: ThreadId.make("subject"), ...subject };
    expect(sortInboxThreadsByReturn([idle, entry])[0]?.id).toBe(top);
    expect(sortInboxThreadsByReturn([entry, idle])[0]?.id).toBe(top);
  });

  it("puts what needs you or finished unseen first, then running agents, then idle threads", () => {
    const done = { ...base, id: ThreadId.make("done"), latestRun: run("completed", 1) };
    const working = {
      ...base,
      id: ThreadId.make("working"),
      latestRun: run("running", 2),
      runtime: running,
    };
    expect(sortInboxThreadsByReturn([idle, working, done]).map((entry) => entry.id)).toEqual([
      "done",
      "working",
      "idle",
    ]);
  });

  it("leaves Fixed order to the dragged keys, whatever you sent", () => {
    const sent = {
      ...base,
      id: ThreadId.make("subject"),
      activeOrderKey: "b",
      latestRun: run("waiting", 2),
      latestUserAuthoredMessageAt: at(10),
    };
    const parked = { ...idle, activeOrderKey: "a" };
    expect(sortActiveThreadsByOrderKey([sent, parked], "fixed").map((t) => t.id)).toEqual([
      "idle",
      "subject",
    ]);
  });
});
