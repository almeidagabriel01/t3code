import { assert, it } from "@effect/vitest";
import type { KanbanAutomations, KanbanColumn } from "@t3tools/contracts";

import {
  decideKanbanAutomation,
  decideSubtaskRollup,
  triggersForRun,
  triggersForThread,
} from "./automation.logic.ts";

const on: KanbanAutomations = {
  threadStarted: true,
  runCompleted: true,
  prMerged: true,
  definitionOfDone: true,
};
const column = (id: string, role: KanbanColumn["role"]) => ({ id: id as KanbanColumn["id"], role });
const board = {
  columns: [
    column("backlog", "backlog"),
    column("todo", "todo"),
    column("doing", "in-progress"),
    column("review", "review"),
    column("done", "done"),
    column("parked", "none"),
  ],
  automations: on,
};
const card = (columnId: string, archivedAt: string | null = null) => ({ columnId, archivedAt });

it("moves forward to the role column and checks the definition of done only for review", () => {
  assert.deepEqual(decideKanbanAutomation("thread-started", card("todo"), board), {
    type: "move",
    columnId: "doing" as KanbanColumn["id"],
    checkDefinitionOfDone: false,
  });
  assert.deepEqual(decideKanbanAutomation("run-completed", card("doing"), board), {
    type: "move",
    columnId: "review" as KanbanColumn["id"],
    checkDefinitionOfDone: true,
  });
  assert.deepEqual(decideKanbanAutomation("pr-merged", card("backlog"), board), {
    type: "move",
    columnId: "done" as KanbanColumn["id"],
    checkDefinitionOfDone: false,
  });
});

it("never moves backwards, sideways, archived cards, or out of a role-less column", () => {
  for (const [trigger, from] of [
    ["thread-started", "doing"],
    ["thread-started", "review"],
    ["run-completed", "review"],
    ["run-completed", "done"],
    ["pr-merged", "done"],
    ["thread-started", "parked"],
    ["pr-merged", "unknown-column"],
  ] as const) {
    assert.strictEqual(decideKanbanAutomation(trigger, card(from), board).type, "skip", from);
  }
  assert.strictEqual(
    decideKanbanAutomation("thread-started", card("todo", "2026-01-01T00:00:00.000Z"), board).type,
    "skip",
  );
});

it("skips a disabled automation and a board without the target role", () => {
  assert.strictEqual(
    decideKanbanAutomation("thread-started", card("todo"), {
      ...board,
      automations: { ...on, threadStarted: false },
    }).type,
    "skip",
  );
  assert.strictEqual(
    decideKanbanAutomation("run-completed", card("todo"), {
      ...board,
      columns: board.columns.filter((c) => c.role !== "review"),
    }).type,
    "skip",
  );
});

it("derives triggers from thread state, ignoring runs that did not complete", () => {
  const runs = [
    { id: "run-1", ordinal: 1, status: "completed" },
    { id: "run-2", ordinal: 2, status: "failed" },
  ];
  assert.deepEqual(triggersForThread({ runs, pullRequests: [] }), [
    { trigger: "thread-started", key: "run-2" },
  ]);
  assert.deepEqual(
    triggersForThread({
      runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
      pullRequests: [
        { key: "h/r#2", state: "open" },
        { key: "h/r#3", state: "merged" },
      ],
    }),
    [
      { trigger: "thread-started", key: "run-1" },
      { trigger: "run-completed", key: "run-1" },
      { trigger: "pr-merged", key: "h/r#3" },
    ],
  );
  assert.deepEqual(triggersForRun({ id: "run-9", status: "running" }), [
    { trigger: "thread-started", key: "run-9" },
  ]);
  assert.deepEqual(triggersForRun({ id: "run-9", status: "queued" }), []);
  assert.deepEqual(triggersForThread({ runs: [], pullRequests: [] }), []);
});

it("moves the parent to review only once every subtask is done, never backwards", () => {
  const done = [card("done"), card("done")];
  assert.deepEqual(decideSubtaskRollup(card("doing"), done, board), {
    type: "move",
    columnId: "review" as KanbanColumn["id"],
    checkDefinitionOfDone: false,
  });
  assert.equal(
    decideSubtaskRollup(card("doing"), [card("done"), card("todo")], board).type,
    "skip",
  );
  assert.equal(decideSubtaskRollup(card("doing"), [], board).type, "skip");
  assert.equal(decideSubtaskRollup(card("review"), done, board).type, "skip");
  assert.equal(decideSubtaskRollup(card("done"), done, board).type, "skip");
  assert.equal(
    decideSubtaskRollup(card("doing"), done, {
      ...board,
      automations: { ...on, runCompleted: false },
    }).type,
    "skip",
  );
});
