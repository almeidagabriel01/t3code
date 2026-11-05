import { assert, it } from "@effect/vitest";

import { assistantMayMessage } from "./AssistantDirectory.ts";

// ceo -> lead -> eng, plus a second top-level pair with no relation to it, and a loner.
const edges = [
  { id: "ceo", reportsTo: null },
  { id: "lead", reportsTo: "ceo" },
  { id: "eng", reportsTo: "lead" },
  { id: "loner", reportsTo: null },
  { id: "loner2", reportsTo: null },
];

it.each([
  ["a leader asks its report", "ceo", "lead", true],
  ["a leader asks a report of a report", "ceo", "eng", true],
  ["a report answers upward by message", "eng", "lead", false],
  ["a report messages the top", "lead", "ceo", false],
  ["siblings in different branches", "eng", "loner", false],
  ["an outsider messages a leader", "loner", "ceo", false],
  ["a leader messages an outsider", "ceo", "loner", false],
  ["two assistants with no org relation", "loner", "loner2", true],
  ["an assistant messaging itself", "eng", "eng", true],
] as const)("assistantMayMessage: %s", (_name, sender, target, allowed) => {
  assert.strictEqual(assistantMayMessage(edges, sender, target), allowed);
});
