import { assert, it } from "@effect/vitest";

import { startableSubtasks, subtaskProgress, subtasksOf } from "./kanbanSubtasks.ts";

const columns = [
  { id: "todo", role: "todo" },
  { id: "done", role: "done" },
] as never;
const card = (id: string, columnId: string, extra: object = {}) =>
  ({ id, parentCardId: "p", columnId, archivedAt: null, linkedThreadIds: [], ...extra }) as never;

it("counts done subtasks and ignores archived ones", () => {
  const cards = [
    card("a", "done"),
    card("b", "todo"),
    card("c", "done", { archivedAt: "x" }),
    card("d", "todo", { parentCardId: null }),
  ];
  const subtasks = subtasksOf(cards, "p");
  assert.deepStrictEqual(subtaskProgress(subtasks, columns), { done: 1, total: 2 });
});

it("starts only open subtasks without a thread", () => {
  const subtasks = [
    card("a", "todo"),
    card("b", "todo", { linkedThreadIds: ["t"] }),
    card("c", "done"),
  ];
  assert.deepStrictEqual(
    startableSubtasks(subtasks, columns).map((c: { id: string }) => c.id),
    ["a"],
  );
});
