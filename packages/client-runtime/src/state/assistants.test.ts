import { assert, describe, it } from "@effect/vitest";
import type { Assistant, AssistantId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  applyAssistantsEvent,
  assistantForThread,
  selectActiveAssistants,
  selectArchivedAssistants,
} from "./assistants.ts";

const assistant = (id: string, overrides: Partial<Assistant> = {}): Assistant => ({
  id: id as AssistantId,
  handle: id,
  name: id,
  projectId: "p" as ProjectId,
  instructions: "",
  toolAccess: "full",
  isDefault: false,
  threadId: `assistant:${id}:1` as ThreadId,
  generation: 1,
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
});
