import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type Decision, type DecisionId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";
import {
  applyDecisionsEvent,
  collectDecisionEntries,
  decisionsStateStream,
  describeSettledDecision,
  formatDecisionExpiry,
  openDecisionCountByThread,
  openDecisionThreadKeys,
  selectOpenDecisions,
  selectSettledDecisions,
} from "./decisions.ts";

const decision = (id: string, thread: string, overrides: Partial<Decision> = {}): Decision => ({
  id: id as DecisionId,
  fromThreadId: thread as ThreadId,
  threadTitle: "T",
  title: id,
  context: "",
  options: [{ id: "a", label: "A" }],
  status: "open",
  createdAt: `2026-10-01T00:00:0${id.length}.000Z`,
  ...overrides,
});

describe("decisions state", () => {
  it("ignores changes before the snapshot, then folds each upsert by id", () => {
    assert.isNull(applyDecisionsEvent(null, { type: "upserted", decision: decision("d", "t1") }));
    const state = applyDecisionsEvent(null, {
      type: "snapshot",
      decisions: [decision("d", "t1"), decision("dd", "t2")],
    })!;
    const answered = applyDecisionsEvent(state, {
      type: "upserted",
      decision: decision("d", "t1", { status: "answered", answeredAt: "2026-10-02T00:00:00.000Z" }),
    })!;
    assert.deepStrictEqual(
      selectOpenDecisions(answered).map((d) => d.id),
      ["dd"],
    );
    assert.deepStrictEqual(
      selectSettledDecisions(answered).map((d) => d.id),
      ["d"],
    );
  });

  it("counts open decisions per thread and keys them per environment", () => {
    const state = applyDecisionsEvent(null, {
      type: "snapshot",
      decisions: [
        decision("d", "t1"),
        decision("dd", "t1"),
        decision("ddd", "t2", { status: "expired" }),
      ],
    })!;
    assert.deepStrictEqual([...openDecisionCountByThread(state)], [["t1", 2]]);
    const env = EnvironmentId.make("env-1");
    assert.deepStrictEqual(
      [...openDecisionThreadKeys([[env, state]])],
      [scopedThreadKey(scopeThreadRef(env, "t1" as ThreadId))],
    );
  });

  it("orders open decisions by soonest expiry, then oldest, across environments", () => {
    const state = (decisions: Decision[]) =>
      applyDecisionsEvent(null, { type: "snapshot", decisions })!;
    const a = EnvironmentId.make("a");
    const b = EnvironmentId.make("b");
    const { open, settled } = collectDecisionEntries([
      [
        a,
        state([
          decision("old", "t1"),
          decision("expires-late", "t1", { expiresAt: "2026-10-09T00:00:00.000Z" }),
        ]),
      ],
      [
        b,
        state([
          decision("expires-soon", "t2", { expiresAt: "2026-10-03T00:00:00.000Z" }),
          decision("done", "t2", { status: "answered", answeredAt: "2026-10-05T00:00:00.000Z" }),
        ]),
      ],
    ]);
    assert.deepStrictEqual(
      open.map((entry) => [entry.environmentId, entry.decision.id]),
      [
        [b, "expires-soon"],
        [a, "expires-late"],
        [a, "old"],
      ],
    );
    assert.deepStrictEqual(
      settled.map((entry) => entry.decision.id),
      ["done"],
    );
  });

  it("words expiry and settled outcomes for people", () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(now + ms));
    assert.deepStrictEqual(
      [30_000, 5 * 60_000, 2 * 3_600_000 + 1, 72 * 3_600_000, -1].map((ms) =>
        formatDecisionExpiry(at(ms), now),
      ),
      ["Expires in 1m", "Expires in 5m", "Expires in 2h", "Expires in 3d", "Expired"],
    );
    const settled = (overrides: Partial<Decision>) =>
      describeSettledDecision(decision("d", "t", overrides));
    assert.deepStrictEqual(
      settled({ status: "answered", answer: { optionId: "a", text: "soon" } }),
      { outcome: "Answered", detail: "A · soon" },
    );
    assert.equal(settled({ status: "withdrawn", answeredAt: at(0) }).outcome, "Dismissed");
    assert.equal(settled({ status: "withdrawn" }).outcome, "Withdrawn");
    assert.equal(settled({ status: "expired" }).outcome, "Expired");
  });

  it.effect("the stream yields state from the snapshot on", () =>
    Effect.gen(function* () {
      const states = yield* decisionsStateStream(
        Stream.fromIterable([
          { type: "upserted" as const, decision: decision("x", "t1") },
          { type: "snapshot" as const, decisions: [] },
          { type: "upserted" as const, decision: decision("d", "t1") },
        ]),
      ).pipe(Stream.runCollect);
      assert.deepStrictEqual(
        [...states].map((state) => state.decisions.size),
        [0, 1],
      );
    }),
  );
});
