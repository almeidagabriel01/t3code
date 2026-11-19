import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { Decision, DECISION_MAX_STEPS, DECISION_STEP_MAX_LENGTH } from "./decisions.ts";

const decode = Schema.decodeUnknownSync(Decision);
const old = {
  id: "d1",
  fromThreadId: "thread-1",
  threadTitle: "Deploy",
  title: "Rotate the key",
  context: "",
  options: [{ id: "done", label: "Done" }],
  status: "open",
  createdAt: "2026-11-01T00:00:00.000Z",
};

describe("Decision", () => {
  it("decodes a decision from a server without kinds or steps, as a choice", () => {
    const decision = decode(old);
    expect(decision).not.toHaveProperty("kind");
    expect(decision).not.toHaveProperty("steps");
  });

  it.each([
    { name: "no steps", steps: [], ok: false },
    { name: "the most steps", steps: Array(DECISION_MAX_STEPS).fill("Open the panel"), ok: true },
    { name: "one step too many", steps: Array(DECISION_MAX_STEPS + 1).fill("Step"), ok: false },
    { name: "the longest step", steps: ["x".repeat(DECISION_STEP_MAX_LENGTH)], ok: true },
    { name: "a step too long", steps: ["x".repeat(DECISION_STEP_MAX_LENGTH + 1)], ok: false },
    { name: "a blank step", steps: ["  "], ok: false },
  ])("takes $name: $ok", ({ steps, ok }) => {
    const run = () => decode({ ...old, kind: "manual", steps });
    if (ok) expect(run().steps).toEqual(steps);
    else expect(run).toThrow();
  });

  it("accepts only the known kinds", () => {
    expect(decode({ ...old, kind: "choice" }).kind).toBe("choice");
    expect(() => decode({ ...old, kind: "todo" })).toThrow();
  });
});
