import { RunId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantMemoryScopeKinds,
  assistantRetryPlan,
  assistantWorkStatus,
  formatNextRun,
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

const base: AssistantWorkStatusInput = {
  assistant: { archivedAt: null, workspace: "host" },
  projectFound: true,
  modelSelection: { instanceId: "claude", model: "opus" } as never,
  providers: [provider()],
  sandbox: null,
  autonomyEnabled: true,
};

describe("assistantWorkStatus", () => {
  it.each([
    ["works", {}, null],
    ["archived", { assistant: { archivedAt: "2026-11-01", workspace: "host" } }, "restore"],
    ["project missing", { projectFound: false }, "editAssistant"],
    [
      "sandbox stopped",
      { assistant: { archivedAt: null, workspace: "sandbox" }, sandbox: { state: "stopped" } },
      "startSandbox",
    ],
    [
      "sandbox not created",
      { assistant: { archivedAt: null, workspace: "sandbox" }, sandbox: { state: "not_created" } },
      "startSandbox",
    ],
    [
      "docker down has no button",
      {
        assistant: { archivedAt: null, workspace: "sandbox" },
        sandbox: { state: "docker_unavailable" },
      },
      "none",
    ],
    [
      "sandbox starting has no button",
      { assistant: { archivedAt: null, workspace: "sandbox" }, sandbox: { state: "starting" } },
      "none",
    ],
    [
      "failed sandbox reports its error",
      {
        assistant: { archivedAt: null, workspace: "sandbox" },
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
    ["autonomy paused", { autonomyEnabled: false }, "resumeAutonomy"],
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
      assistant: { archivedAt: null, workspace: "sandbox" },
      sandbox: { state: "failed", error: "port busy" },
    });
    expect(status).toMatchObject({ ok: false, severity: "blocked", detail: "port busy" });
  });

  it("only limits, not blocks, while autonomy is paused", () => {
    expect(assistantWorkStatus({ ...base, autonomyEnabled: false })).toMatchObject({
      severity: "limited",
    });
  });

  it("puts the most fundamental reason first", () => {
    const status = assistantWorkStatus({
      ...base,
      assistant: { archivedAt: "2026-11-01", workspace: "host" },
      projectFound: false,
      providers: [],
      autonomyEnabled: false,
    });
    expect(status).toMatchObject({ fix: { kind: "restore" } });
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

describe("formatNextRun", () => {
  const now = new Date(2026, 10, 9, 10, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 30).toISOString();
  it("says today, tomorrow, a weekday within a week, then the date", () => {
    expect(formatNextRun(at(9, 14), now)).toMatch(/^Today /);
    expect(formatNextRun(at(10, 9), now)).toMatch(/^Tomorrow /);
    expect(formatNextRun(at(12, 9), now)).toMatch(/^Thu /);
    expect(formatNextRun(at(20, 9), now)).toMatch(/^Nov 20, /);
  });
  it("is empty for a value that is not a date", () => {
    expect(formatNextRun("soon", now)).toBe("");
  });
});
