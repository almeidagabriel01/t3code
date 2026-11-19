import { assert, it } from "@effect/vitest";

import { aggregateInstanceSpend, type SpendTurn } from "./InstanceSpend.ts";

const pricing = {
  rates: new Map([
    [
      "test-model",
      {
        inputCostPerToken: 1e-6,
        outputCostPerToken: 2e-6,
        cacheReadCostPerToken: 1e-7,
        cacheCreationCostPerToken: 1.5e-6,
        fast: null,
        ultrafast: null,
      },
    ],
  ]),
  overrides: new Map(),
  aliases: new Map<string, string>(),
};
// 1000 in + 500 out on test-model = 0.002 USD.
const turn = (
  providerInstanceId: string,
  at: string,
  over: Partial<SpendTurn> = {},
): SpendTurn => ({
  providerInstanceId,
  model: "test-model",
  at,
  usage: { usageStatus: "complete", inputTokens: 1000, outputTokens: 500 },
  ...over,
});
const now = Date.parse("2026-10-28T02:00:00Z");

it("groups by instance and splits today from the 30-day period in the client zone", () => {
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-28T01:00:00Z"),
      // Still Oct 27 in Sao Paulo (UTC-3), already Oct 28 in UTC.
      turn("a", "2026-10-28T01:30:00Z"),
      turn("a", "2026-10-20T12:00:00Z"),
      turn("a", "2026-09-01T12:00:00Z"),
      turn("b", "2026-10-27T12:00:00Z"),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  const a = result.instances.find((row) => row.providerInstanceId === "a")!;
  assert.closeTo(a.todayUsd, 0.004, 1e-9);
  assert.closeTo(a.periodUsd, 0.006, 1e-9);
  assert.isFalse(a.partial);
  const local = aggregateInstanceSpend({
    turns: [turn("a", "2026-10-28T01:00:00Z"), turn("a", "2026-10-27T20:00:00Z")],
    pricing,
    now,
    timeZone: "America/Sao_Paulo",
  });
  assert.closeTo(local.instances[0]!.todayUsd, 0.004, 1e-9);
  assert.closeTo(local.instances[0]!.periodUsd, 0.004, 1e-9);
});

it("marks partial when usage is missing or unpriced but still sums what is priced", () => {
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-28T01:00:00Z"),
      turn("a", "2026-10-28T01:00:00Z", { usage: null }),
      turn("a", "2026-10-28T01:00:00Z", { model: "unknown-model" }),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  assert.isTrue(result.instances[0]!.partial);
  assert.closeTo(result.instances[0]!.todayUsd, 0.002, 1e-9);
});

it("splits an instance's spend by consumer, folding assistant generations and capping the list", () => {
  const base = { environmentId: "env", providerInstanceId: "a" };
  const thread = (id: string) => ({ kind: "thread" as const, threadId: id, ...base });
  const result = aggregateInstanceSpend({
    turns: [
      turn("a", "2026-10-20T12:00:00Z", {
        consumer: { kind: "assistant", threadId: "assistant:j:1", assistantId: "j", ...base },
      }),
      turn("a", "2026-10-28T01:00:00Z", {
        consumer: { kind: "assistant", threadId: "assistant:j:2", assistantId: "j", ...base },
      }),
      turn("a", "2026-10-28T01:00:00Z", {
        consumer: { kind: "subagent", threadId: "child", parentThreadId: "t0", ...base },
      }),
      ...Array.from({ length: 9 }, (_, n) =>
        turn("a", "2026-10-27T12:00:00Z", { consumer: thread(`t${n}`) }),
      ),
      turn("a", "2026-10-28T01:00:00Z"),
    ],
    pricing,
    now,
    timeZone: "UTC",
  });
  const a = result.instances[0] as (typeof result.instances)[number] & {
    consumers: ReadonlyArray<{
      consumer: { threadId: string };
      todayUsd: number;
      periodUsd: number;
    }>;
    consumerKinds: ReadonlyArray<{ kind: string; todayUsd: number; periodUsd: number }>;
  };
  assert.closeTo(a.periodUsd, 0.026, 1e-9);
  assert.strictEqual(a.consumers.length, 8);
  assert.strictEqual(a.consumers[0]!.consumer.threadId, "assistant:j:2");
  assert.closeTo(a.consumers[0]!.periodUsd, 0.004, 1e-9);
  assert.closeTo(a.consumers[0]!.todayUsd, 0.002, 1e-9);
  assert.strictEqual(a.consumers[1]!.consumer.threadId, "child");
  const kinds = Object.fromEntries(a.consumerKinds.map((row) => [row.kind, row.periodUsd]));
  assert.closeTo(kinds.thread!, 0.018, 1e-9);
  assert.closeTo(kinds.assistant!, 0.004, 1e-9);
  assert.closeTo(kinds.subagent!, 0.002, 1e-9);
});
