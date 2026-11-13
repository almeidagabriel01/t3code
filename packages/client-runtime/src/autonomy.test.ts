import { ProjectId, type AutonomyWatch } from "@t3tools/contracts";
import { DEFAULT_AUTONOMY_SETTINGS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTONOMY_MINUTES_BOUNDS,
  AUTONOMY_NOTIFY_AFTER_BOUNDS,
  AUTONOMY_USER_MESSAGES_BOUNDS,
  EMPTY_WATCH_DRAFT,
  type AutonomyWatchDraft,
  parseBoundedInt,
  sameAssistantAutonomy,
  toggleInList,
  watchDraftFromWatch,
  watchInputFromDraft,
  watchReply,
  watchSummary,
  withAutonomyChannel,
  withAutonomyRule,
} from "./autonomy.ts";

const project = ProjectId.make("p1");

describe("autonomy helpers", () => {
  it("parses bounded integers", () => {
    expect(parseBoundedInt("30", AUTONOMY_MINUTES_BOUNDS)).toBe(30);
    expect(parseBoundedInt(" 1440 ", AUTONOMY_MINUTES_BOUNDS)).toBe(1440);
    for (const bad of ["", "0", "1441", "1.5", "-3", "abc"]) {
      expect(parseBoundedInt(bad, AUTONOMY_MINUTES_BOUNDS)).toBeNull();
    }
    expect(parseBoundedInt("0", AUTONOMY_NOTIFY_AFTER_BOUNDS)).toBe(0);
    expect(parseBoundedInt("60", AUTONOMY_NOTIFY_AFTER_BOUNDS)).toBe(60);
    expect(parseBoundedInt("61", AUTONOMY_NOTIFY_AFTER_BOUNDS)).toBeNull();
    expect(parseBoundedInt("0", AUTONOMY_USER_MESSAGES_BOUNDS)).toBeNull();
    expect(parseBoundedInt("1000", AUTONOMY_USER_MESSAGES_BOUNDS)).toBe(1000);
  });

  it("keeps canonical order when toggling lists", () => {
    expect(toggleInList(["a", "b", "c"], ["c"], "a", true)).toEqual(["a", "c"]);
    expect(toggleInList(["a", "b", "c"], ["a", "c"], "a", false)).toEqual(["c"]);
  });

  it("returns whole settings objects", () => {
    const next = withAutonomyRule(DEFAULT_AUTONOMY_SETTINGS, "stuck", false);
    expect(next.rules).toEqual({ ...DEFAULT_AUTONOMY_SETTINGS.rules, stuck: false });
    expect(withAutonomyChannel(next, "telegram", false).channels).toEqual(["t3"]);
    expect(withAutonomyChannel({ ...next, channels: [] }, "t3", true).channels).toEqual(["t3"]);
  });

  it.each<[Partial<AutonomyWatchDraft>, string]>([
    [{ title: " " }, "Give the watch a title."],
    [{ title: "x".repeat(121) }, "The title is at most 120 characters."],
    [{ title: "x", instruction: "y".repeat(2001) }, "The instruction is at most 2000 characters."],
    [{ title: "x", prNumber: "abc" }, "The PR number must be a positive whole number."],
    [{ title: "x", expiresAt: "nope" }, "The expiry is not a date."],
  ])("rejects a bad draft %#", (patch, message) => {
    expect(watchInputFromDraft("a1", { ...EMPTY_WATCH_DRAFT, ...patch })).toEqual({
      ok: false,
      message,
    });
  });

  it("round-trips a watch through its draft and drops the PR number for other events", () => {
    const watch: AutonomyWatch = {
      id: "w1" as AutonomyWatch["id"],
      assistantId: "a1",
      title: "CI",
      filter: { event: "pr_checks_failed", projectId: project, prNumber: 42 },
      instruction: "Tell me why",
      oneShot: true,
      expiresAt: "2030-01-02T10:30:00.000Z",
      enabled: true,
      triggerCount: 0,
      lastTriggeredAt: null,
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const draft = watchDraftFromWatch(watch);
    expect(draft.prNumber).toBe("42");
    const result = watchInputFromDraft("a1", draft);
    expect(result).toMatchObject({
      ok: true,
      input: { id: "w1", filter: watch.filter, oneShot: true, expiresAt: watch.expiresAt },
    });
    const other = watchInputFromDraft("a1", { ...draft, event: "run_failed" });
    expect(other).toMatchObject({ ok: true, input: { filter: { event: "run_failed" } } });
    expect(watchSummary(watch, () => "Acme")).toBe("PR checks fail · Acme · PR #42");
    expect(watchSummary({ filter: { event: "run_failed" } }, () => null)).toBe("A run fails");
  });
});

describe("sameAssistantAutonomy", () => {
  const base = { mode: "reply-only", rules: null, projectIds: null, channels: null } as const;
  it("treats lists as sets and null as distinct from empty", () => {
    expect(sameAssistantAutonomy(base, { ...base })).toBe(true);
    expect(sameAssistantAutonomy(base, { ...base, rules: [] })).toBe(false);
    expect(
      sameAssistantAutonomy(
        { ...base, rules: ["stuck", "runFailed"] },
        { ...base, rules: ["runFailed", "stuck"] },
      ),
    ).toBe(true);
    expect(sameAssistantAutonomy(base, { ...base, mode: "reply-and-notify" })).toBe(false);
    expect(
      sameAssistantAutonomy({ ...base, channels: ["t3"] }, { ...base, channels: ["telegram"] }),
    ).toBe(false);
    expect(
      sameAssistantAutonomy({ ...base, projectIds: [project] }, { ...base, projectIds: [] }),
    ).toBe(false);
  });
});

describe("watchReply", () => {
  it.each([
    [{ _tag: "Success" as const }, { ok: true }],
    [
      { _tag: "Failure" as const, cause: Cause.fail(new Error("Too many watches")) },
      { ok: false, message: "Too many watches" },
    ],
    [
      { _tag: "Failure" as const, cause: Cause.fail("boom") },
      { ok: false, message: "The request failed. Try again." },
    ],
  ])("settles %# into a reply", (result, reply) => {
    expect(watchReply(result)).toEqual(reply);
  });
});
