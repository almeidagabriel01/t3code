import { assert, describe, it } from "@effect/vitest";
import type {
  Assistant,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  AssistantSandboxStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyAssistantsEvent,
  assistantForTaskThread,
  assistantForThread,
  selectAssistantTasks,
  selectActiveAssistants,
  selectArchivedAssistants,
  selectTeams,
  assistantSandboxView,
  sandboxCpuChoices,
  sandboxCpuLabel,
} from "./assistants.ts";

const assistant = (id: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name: id,
  projectIds: [],
  projectId: "p" as ProjectId,
  instructions: "",
  toolAccess: "full",
  askBeforeActing: false,
  workspace: "host",
  icon: null,
  avatar: null,
  scope: "all",
  mcpServers: [],
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  role: "",
  budget: null,
  autonomy: { mode: "reply-only", rules: null, projectIds: null, channels: null },
  archivedAt: null,
  createdAt: `2026-10-01T00:00:0${id.length}.000Z`,
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

describe("assistants state", () => {
  it("ignores changes before the snapshot, then folds upserts and removals by id", () => {
    assert.isNull(applyAssistantsEvent(null, { type: "upserted", assistant: assistant("a") }));
    const state = applyAssistantsEvent(null, {
      type: "snapshot",
      assistants: [assistant("jarvis", { isDefault: true }), assistant("bb"), assistant("c")],
      teams: [],
      tasks: [],
    })!;
    const archived = applyAssistantsEvent(state, {
      type: "upserted",
      assistant: assistant("bb", { archivedAt: "2026-10-02T00:00:00.000Z" }),
    })!;
    const removed = applyAssistantsEvent(archived, {
      type: "removed",
      assistantId: "c" as AssistantId,
    })!;
    assert.deepStrictEqual(
      selectActiveAssistants(archived).map((a) => a.id),
      ["jarvis", "c"],
    );
    assert.deepStrictEqual(
      selectArchivedAssistants(archived).map((a) => a.id),
      ["bb"],
    );
    assert.deepStrictEqual(
      selectActiveAssistants(removed).map((a) => a.id),
      ["jarvis"],
    );
    assert.strictEqual(assistantForThread(removed, "assistant:jarvis:1" as ThreadId)?.id, "jarvis");
    assert.isUndefined(assistantForThread(removed, "assistant:jarvis:0" as ThreadId));
  });

  it("folds task links next to assistants and finds a thread's owner", () => {
    const link = (threadId: string, assistantId: string) => ({
      threadId: threadId as ThreadId,
      assistantId: assistantId as AssistantId,
      projectId: "p" as ProjectId,
      title: threadId,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    const state = applyAssistantsEvent(null, {
      type: "snapshot",
      assistants: [assistant("a"), assistant("b")],
      teams: [],
      tasks: [link("t1", "a")],
    })!;
    const added = applyAssistantsEvent(state, { type: "taskUpserted", task: link("t2", "b") })!;
    assert.deepStrictEqual(
      selectAssistantTasks(added, "a" as AssistantId).map((task) => task.threadId),
      ["t1"],
    );
    assert.strictEqual(assistantForTaskThread(added, "t2" as ThreadId)?.id, "b");
    assert.isUndefined(assistantForTaskThread(added, "other" as ThreadId));
    assert.isNull(applyAssistantsEvent(null, { type: "taskUpserted", task: link("t3", "a") }));
  });

  it("folds team events next to assistant ones, oldest team first", () => {
    const team = (id: string, createdAt: string): AssistantTeam => ({
      id: id as AssistantTeamId,
      name: id,
      memberIds: ["a", "b"] as AssistantId[],
      leadId: null,
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    const state = applyAssistantsEvent(null, {
      type: "snapshot",
      assistants: [assistant("a")],
      teams: [team("t2", "2026-10-02T00:00:00.000Z")],
      tasks: [],
    })!;
    const added = applyAssistantsEvent(state, {
      type: "teamUpserted",
      team: team("t1", "2026-10-01T00:00:00.000Z"),
    })!;
    assert.deepStrictEqual(
      selectTeams(added).map((entry) => entry.id),
      ["t1", "t2"],
    );
    assert.strictEqual(added.assistants.size, 1);
    const removed = applyAssistantsEvent(added, {
      type: "teamRemoved",
      teamId: "t1" as AssistantTeamId,
    })!;
    assert.deepStrictEqual(
      selectTeams(removed).map((entry) => entry.id),
      ["t2"],
    );
    assert.isNull(
      applyAssistantsEvent(null, { type: "teamRemoved", teamId: "t1" as AssistantTeamId }),
    );
  });
});

describe("assistantSandboxView", () => {
  const status = (overrides: Partial<AssistantSandboxStatus>): AssistantSandboxStatus => ({
    state: "running",
    step: null,
    error: null,
    environmentId: "environment-box" as AssistantSandboxStatus["environmentId"],
    url: "http://127.0.0.1:49152",
    linkedEnvironmentsEnabled: true,
    cpus: null,
    whenDone: "discard",
    ...overrides,
  });

  it.each([
    [null, "Checking", false, false, false, false],
    [
      status({ state: "not_created", environmentId: null }),
      "Not created",
      true,
      false,
      false,
      false,
    ],
    [status({ state: "starting", step: "Linking" }), "Starting", false, false, false, false],
    [status({}), "Running", false, true, true, true],
    [status({ state: "stopped" }), "Stopped", true, false, true, false],
    [status({ state: "failed", error: "Refused" }), "Failed", true, false, true, false],
    [status({ state: "docker_unavailable" }), "Docker not available", false, false, false, false],
  ] as const)("reads %j", (input, label, canStart, canStop, canRemove, canSignIn) => {
    const view = assistantSandboxView(input);
    assert.deepInclude(view, { label, canStart, canStop, canRemove, canSignIn });
  });

  it("explains a step, a failure and a missing Docker", () => {
    assert.strictEqual(
      assistantSandboxView(status({ state: "starting", step: "Linking" })).detail,
      "Linking",
    );
    assert.strictEqual(
      assistantSandboxView(status({ state: "failed", error: "Refused" })).detail,
      "Refused",
    );
    assert.include(
      assistantSandboxView(status({ state: "docker_unavailable" })).unavailableReason ?? "",
      "Docker",
    );
    assert.isNull(assistantSandboxView(status({})).unavailableReason);
    assert.isFalse(assistantSandboxView(status({ environmentId: null })).canSignIn);
  });
});

describe("sandboxCpuChoices", () => {
  it("offers no limit first, the presets, and a stored value that is not a preset in order", () => {
    assert.deepStrictEqual(
      sandboxCpuChoices(null).map((choice) => choice.label),
      ["No limit", "1 core", "2 cores", "4 cores", "8 cores", "16 cores"],
    );
    assert.deepStrictEqual(
      sandboxCpuChoices(3).map((choice) => choice.value),
      [null, 1, 2, 3, 4, 8, 16],
    );
    assert.strictEqual(sandboxCpuChoices(4).length, 6);
    assert.strictEqual(sandboxCpuLabel(3), "3 cores");
  });
});
