import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as M from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Worker from "./MemoryWorker.ts";
import * as ThreadHandoffSummary from "./ThreadHandoffSummary.ts";
import {
  encodeMessage,
  environmentId,
  id,
  live,
  decodeMessage,
  now,
  seed,
  selection,
  threadId,
} from "./MemoryWorker.testkit.ts";

type Generate = NonNullable<Generation.TextGeneration["Service"]["generateMemorySummary"]>;

const outcome = (input: M.GenerateMemorySummaryInput, text: string) =>
  Effect.succeed({
    result: {
      text,
      assertionKind: "inference" as const,
      evidence: [
        {
          origin: "thread" as const,
          sourceThread: input.sourceThread,
          watermark: input.sourceWatermark,
          messageIds: input.messages.map((message) => message.messageId),
        },
      ],
    },
    execution: {
      requestedModelSelection: input.modelSelection,
      effectiveModel: "fixture",
      effectiveProvider: M.ProviderDriverKind.make("codex"),
      providerInstanceId: selection.instanceId,
      environmentId,
    },
  });

// The worker's own generator (inside `live`) writes the stored summary; `generateMemorySummary` is
// the handoff's, so a call to it means the stored summary was not reused.
const layerFor = (
  generation: Partial<Generation.TextGeneration["Service"]>,
  options: { readonly memoryOff?: boolean } = {},
) =>
  ThreadHandoffSummary.layer.pipe(
    Layer.provide(Layer.mock(Generation.TextGeneration)(generation)),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(live(false, undefined, true, 0, options.memoryOff === true)),
  );

const counting = (text: string) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<M.GenerateMemorySummaryInput>>([]);
    const generateMemorySummary: Generate = (input) =>
      Ref.update(calls, (all) => [...all, input]).pipe(Effect.andThen(outcome(input, text)));
    return { calls, generateMemorySummary };
  });

it.effect("generates a summary on the memory model when none is stored", () =>
  Effect.gen(function* () {
    const { calls, generateMemorySummary } = yield* counting("generated summary");
    return yield* Effect.gen(function* () {
      yield* seed;
      const summary = yield* ThreadHandoffSummary.ThreadHandoffSummary;
      assert.strictEqual(yield* summary.summarize(threadId), "generated summary");
      const [input] = yield* Ref.get(calls);
      assert.deepStrictEqual(
        input?.messages.map((message) => message.messageId),
        ["message"],
      );
      assert.deepStrictEqual(input?.modelSelection, selection);
    }).pipe(Effect.provide(layerFor({ generateMemorySummary })));
  }),
);

it.effect(
  "reuses the memory summary while it covers the thread, and regenerates once it is stale",
  () =>
    Effect.gen(function* () {
      const { calls, generateMemorySummary } = yield* counting("generated summary");
      yield* Effect.gen(function* () {
        yield* seed;
        yield* (yield* Worker.MemoryWorker).sweepDue();
        const summary = yield* ThreadHandoffSummary.ThreadHandoffSummary;
        const stored = yield* summary.summarize(threadId);
        assert.notStrictEqual(stored, "generated summary");
        assert.lengthOf(yield* Ref.get(calls), 0);

        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_events WHERE sequence=1`;
        const original = yield* decodeMessage(row!.payload_json);
        yield* sql`INSERT INTO orchestration_events VALUES (3,${id(20)},${threadId},'message.updated',${encodeMessage({ ...original, id: M.MessageId.make("newer"), runId: null })},${now},2,'thread')`;
        assert.strictEqual(yield* summary.summarize(threadId), "generated summary");
        assert.lengthOf(yield* Ref.get(calls), 1);
      }).pipe(Effect.provide(layerFor({ generateMemorySummary })));
    }),
);

it.effect.each([
  {
    name: "memory is off",
    generation: {},
    memoryOff: true,
    reason: "unavailable",
  },
  {
    name: "the provider cannot summarize",
    generation: {
      generateMemorySummary: () =>
        Effect.fail(
          new M.TextGenerationError({
            operation: "generateMemorySummary",
            detail: "unsupported_operation",
          }),
        ),
    },
    memoryOff: false,
    reason: "unavailable",
  },
])("refuses a summary when $name", ({ generation, memoryOff, reason }) =>
  Effect.gen(function* () {
    yield* seed;
    const summary = yield* ThreadHandoffSummary.ThreadHandoffSummary;
    const error = yield* Effect.flip(summary.summarize(threadId));
    assert.strictEqual(error.reason, reason);
  }).pipe(Effect.provide(layerFor(generation, { memoryOff }))),
);

it.effect("returns no summary when the model finds nothing to keep", () =>
  Effect.gen(function* () {
    yield* seed;
    const summary = yield* ThreadHandoffSummary.ThreadHandoffSummary;
    assert.isNull(yield* summary.summarize(threadId));
  }).pipe(
    Effect.provide(
      layerFor(
        {
          generateMemorySummary: ((input) =>
            outcome(input, "x").pipe(
              Effect.map((output) => ({ ...output, result: null })),
            )) as Generate,
        },
        { memoryOff: false },
      ),
    ),
  ),
);
