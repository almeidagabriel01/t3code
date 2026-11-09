import { RunId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantMemories,
  assistantMemoryScopeKinds,
  assistantRetryPlan,
  assistantWorkStatus,
  formatNextRun,
  memorySourceLabel,
  type AssistantWorkStatusInput,
} from "./assistantWork.ts";

const provider = (overrides: Record<string, unknown> = {}) =>
  ({
    instanceId: "claude",
    displayName: "Claude",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [{ slug: "opus" }],
    ...overrides,
  }) as unknown as ServerProvider;

const asst = (workspace: "host" | "sandbox", mode = "reply-only") =>
  ({ workspace, autonomy: { mode } }) as unknown as AssistantWorkStatusInput["assistant"];

const base: AssistantWorkStatusInput = {
  assistant: asst("host"),
  projectFound: true,
  modelSelection: { instanceId: "claude", model: "opus" } as never,
  providers: [provider()],
  sandbox: null,
  autonomyEnabled: true,
};

describe("assistantWorkStatus", () => {
  it.each([
    ["works", {}, null],
    ["project missing", { projectFound: false }, "editAssistant"],
    [
      "sandbox stopped",
      { assistant: asst("sandbox"), sandbox: { state: "stopped" } },
      "startSandbox",
    ],
    [
      "sandbox not created",
      { assistant: asst("sandbox"), sandbox: { state: "not_created" } },
      "startSandbox",
    ],
    [
      "docker down has no button",
      {
        assistant: asst("sandbox"),
        sandbox: { state: "docker_unavailable" },
      },
      "none",
    ],
    [
      "sandbox starting has no button",
      { assistant: asst("sandbox"), sandbox: { state: "starting" } },
      "none",
    ],
    [
      "failed sandbox reports its error",
      {
        assistant: asst("sandbox"),
        sandbox: { state: "failed", error: "port busy" },
      },
      "startSandbox",
    ],
    ["host assistant ignores a stopped sandbox", { sandbox: { state: "stopped" } }, null],
    ["provider missing", { providers: [] }, "providers"],
    ["provider off", { providers: [provider({ enabled: false })] }, "providers"],
    ["provider not installed", { providers: [provider({ installed: false })] }, "providers"],
    ["provider down", { providers: [provider({ availability: "unavailable" })] }, "providers"],
    [
      "provider signed out",
      { providers: [provider({ auth: { status: "unauthenticated" } })] },
      "providers",
    ],
    ["auth unknown still works", { providers: [provider({ auth: { status: "unknown" } })] }, null],
    ["model gone", { providers: [provider({ models: [{ slug: "sonnet" }] })] }, "editAssistant"],
    ["provider lists no models yet", { providers: [provider({ models: [] })] }, null],
    ["providers not loaded", { providers: null }, null],
    ["no thread yet", { modelSelection: null }, null],
    [
      "autonomy paused, set to notify",
      { autonomyEnabled: false, assistant: asst("host", "reply-and-notify") },
      "resumeAutonomy",
    ],
    ["autonomy paused, reply only", { autonomyEnabled: false }, null],
    ["autonomy unknown", { autonomyEnabled: null }, null],
  ] as const)("%s", (_name, overrides, fix) => {
    const status = assistantWorkStatus({ ...base, ...overrides } as AssistantWorkStatusInput);
    if (fix === null) return expect(status).toEqual({ ok: true });
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.fix?.kind ?? "none").toBe(fix);
    expect(status.title).not.toBe("");
  });

  it("names the failure of a sandbox that could not start", () => {
    const status = assistantWorkStatus({
      ...base,
      assistant: asst("sandbox"),
      sandbox: { state: "failed", error: "port busy" },
    });
    expect(status).toMatchObject({ ok: false, severity: "blocked", detail: "port busy" });
  });

  it("only limits, not blocks, while autonomy is paused", () => {
    expect(
      assistantWorkStatus({
        ...base,
        assistant: asst("host", "reply-and-notify"),
        autonomyEnabled: false,
      }),
    ).toMatchObject({
      severity: "limited",
    });
  });

  it("puts the most fundamental reason first", () => {
    const status = assistantWorkStatus({
      ...base,
      assistant: asst("sandbox"),
      projectFound: false,
      sandbox: { state: "stopped", error: null },
      providers: [],
      autonomyEnabled: false,
    });
    expect(status).toMatchObject({ title: "Its project is missing" });
  });
});

describe("assistantRetryPlan", () => {
  const runId = RunId.make("run:1");
  const shell = (status: string, lastErrorClass: string | null = null) =>
    ({ latestRun: { runId, status }, runtime: { lastErrorClass } }) as never;
  it.each([
    ["interrupted continues", shell("interrupted"), { kind: "continue", runId }],
    ["usage limit continues", shell("failed", "usage_limit"), { kind: "continue", runId }],
    ["a plain failure asks again", shell("failed", "provider_error"), { kind: "again" }],
    [
      "a failure with no runtime asks again",
      { latestRun: { runId, status: "failed" } },
      { kind: "again" },
    ],
    ["completed needs nothing", shell("completed"), null],
    ["running needs nothing", shell("running"), null],
    ["no run needs nothing", { latestRun: null, runtime: null }, null],
    ["no thread needs nothing", null, null],
  ] as const)("%s", (_name, input, expected) => {
    expect(assistantRetryPlan(input as never)).toEqual(expected);
  });
});

describe("assistantMemoryScopeKinds", () => {
  it("adds the project only for a project assistant", () => {
    expect(assistantMemoryScopeKinds({ scope: "all" })).toEqual(["thread"]);
    expect(assistantMemoryScopeKinds({ scope: "project" })).toEqual(["thread", "project"]);
  });
});

describe("assistantMemories", () => {
  const memory = (
    memoryId: string,
    createdAtUtc: string,
    scope: unknown,
    threadId: string | null,
    status = "active",
  ) =>
    ({
      memoryId,
      status,
      scope,
      revision: { createdAtUtc },
      payload: {
        evidence:
          threadId === null
            ? [{ origin: "user", messageIds: [] }]
            : [
                {
                  origin: "thread",
                  sourceThread: { environmentId: "env", threadId },
                  messageIds: [],
                },
              ],
      },
    }) as never;
  it("keeps what its conversations taught, newest first, once, and says where from", () => {
    const items = [
      memory("old", "2026-11-01T00:00:00Z", { kind: "user" }, "assistant:ada:1"),
      memory("new", "2026-11-05T00:00:00Z", { kind: "project" }, "assistant:ada:g-abc"),
      memory("dupe", "2026-11-06T00:00:00Z", { kind: "user" }, "assistant:ada:2"),
      memory("dupe", "2026-11-07T00:00:00Z", { kind: "user" }, "assistant:ada:2"),
      memory("other assistant", "2026-11-04T00:00:00Z", { kind: "user" }, "assistant:bob:1"),
      memory("ordinary thread", "2026-11-04T00:00:00Z", { kind: "user" }, "thread:x"),
      memory("typed by the user", "2026-11-04T00:00:00Z", { kind: "user" }, null),
      memory("forgotten", "2026-11-04T00:00:00Z", { kind: "user" }, "assistant:ada:1", "forgotten"),
    ];
    expect(
      assistantMemories(items, "ada", "env").map((entry) => [
        entry.item.memoryId,
        entry.sourceThreadId,
      ]),
    ).toEqual([
      ["dupe", "assistant:ada:2"],
      ["new", "assistant:ada:g-abc"],
      ["old", "assistant:ada:1"],
    ]);
  });
  it("counts the memories scoped to its own conversation even without thread evidence", () => {
    const own = memory(
      "own",
      "2026-11-01T00:00:00Z",
      { kind: "thread", thread: { threadId: "assistant:ada:3" } },
      null,
    );
    const elsewhere = memory(
      "else",
      "2026-11-01T00:00:00Z",
      { kind: "thread", thread: { threadId: "thread:z" } },
      null,
    );
    expect(
      assistantMemories([own, elsewhere], "ada", "env", new Set(["assistant:ada:3"])).map(
        (entry) => [entry.item.memoryId, entry.sourceThreadId],
      ),
    ).toEqual([["own", "assistant:ada:3"]]);
  });
});

describe("memorySourceLabel", () => {
  it.each([
    ["Trip planning", "Trip planning"],
    ["  Trip planning ", "Trip planning"],
    ["", "From a conversation"],
    ["   ", "From a conversation"],
    [null, "From a conversation"],
    [undefined, "From a conversation"],
  ])("%j -> %s", (title, label) => {
    expect(memorySourceLabel(title)).toBe(label);
  });
});

describe("formatNextRun", () => {
  // Whole days apart keep the same local time, so the day words hold in every time zone.
  const now = Date.UTC(2026, 10, 9, 12, 0);
  const DAY = 86_400_000;
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const clock = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);
  it("says today, tomorrow, a weekday within a week, then the date", () => {
    const weekday = (ms: number) =>
      new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(ms);
    const monthDay = (ms: number) =>
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(ms);
    expect(formatNextRun(iso(now + 60_000), now)).toBe(`Today ${clock(now + 60_000)}`);
    expect(formatNextRun(iso(now + DAY), now)).toBe(`Tomorrow ${clock(now + DAY)}`);
    expect(formatNextRun(iso(now + 3 * DAY), now)).toBe(
      `${weekday(now + 3 * DAY)} ${clock(now + 3 * DAY)}`,
    );
    expect(formatNextRun(iso(now + 11 * DAY), now)).toBe(
      `${monthDay(now + 11 * DAY)}, ${clock(now + 11 * DAY)}`,
    );
    // The past is shown by its date, not as "Today".
    expect(formatNextRun(iso(now - 3 * DAY), now)).toBe(
      `${monthDay(now - 3 * DAY)}, ${clock(now - 3 * DAY)}`,
    );
  });
  it("is empty for a value that is not a date", () => {
    expect(formatNextRun("soon", now)).toBe("");
  });
});
