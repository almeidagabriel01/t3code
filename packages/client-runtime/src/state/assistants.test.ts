import { assert, describe, it } from "@effect/vitest";
import type {
  Assistant,
  AssistantId,
  AssistantTeam,
  AssistantTeamId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyAssistantsEvent,
  assistantForThread,
  selectActiveAssistants,
  selectArchivedAssistants,
  selectTeams,
} from "./assistants.ts";

const assistant = (id: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name: id,
  projectId: "p" as ProjectId,
  instructions: "",
  toolAccess: "full",
  askBeforeActing: false,
  icon: null,
  mcpServers: [],
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
  role: "",
  reportsTo: null,
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

  it("folds team events next to assistant ones, oldest team first", () => {
    const team = (id: string, createdAt: string): AssistantTeam => ({
      id: id as AssistantTeamId,
      name: id,
      memberIds: ["a", "b"] as AssistantId[],
      leaderId: null,
      leaderTitle: null,
      createdAt,
      updatedAt: createdAt,
    });
    const state = applyAssistantsEvent(null, {
      type: "snapshot",
      assistants: [assistant("a")],
      teams: [team("t2", "2026-10-02T00:00:00.000Z")],
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
