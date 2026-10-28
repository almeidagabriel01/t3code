import { assert, it } from "@effect/vitest";

import { checkDefinitionOfDone } from "./definitionOfDone.ts";

const open = [
  { text: "Write it", done: true },
  { text: "Test it", done: false },
];

it("passes outside review and done, or when disabled", () => {
  assert.deepEqual(
    checkDefinitionOfDone({
      enabled: true,
      targetRole: "in-progress",
      checklist: open,
      summary: undefined,
    }),
    { ok: true },
  );
  assert.deepEqual(
    checkDefinitionOfDone({ enabled: false, targetRole: "done", checklist: open, summary: "" }),
    { ok: true },
  );
});

it("lists every unfinished item and a missing summary", () => {
  assert.deepEqual(
    checkDefinitionOfDone({ enabled: true, targetRole: "review", checklist: open, summary: "  " }),
    {
      ok: false,
      missing: ["checklist item not done: Test it", "a completion summary (the `summary` field)"],
    },
  );
});

it("passes a finished checklist with a summary, and an empty checklist with one", () => {
  const done = open.map((item) => ({ ...item, done: true }));
  assert.deepEqual(
    checkDefinitionOfDone({ enabled: true, targetRole: "done", checklist: done, summary: "Done." }),
    { ok: true },
  );
  assert.deepEqual(
    checkDefinitionOfDone({ enabled: true, targetRole: "done", checklist: [], summary: "Done." }),
    { ok: true },
  );
});
