import * as M from "@t3tools/contracts";
import { resolveMemoryModelSelection } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Store from "./MemoryStore.ts";
import { generateSummaryChunks } from "./memorySummaryChunks.ts";
import { boundSourcePage, readEligibleSourceRows } from "./memorySourceScan.ts";

export class ThreadHandoffSummaryError extends Schema.TaggedError<ThreadHandoffSummaryError>()(
  "ThreadHandoffSummaryError",
  {
    /** `unavailable`: memory is off or its model's provider cannot summarize. `failed`: the run did. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ThreadHandoffSummary extends Context.Service<
  ThreadHandoffSummary,
  {
    /**
     * The thread's summary for a handoff: the memory summary when it already covers the thread's
     * latest messages, else one generated now on the memory model. Nothing is stored.
     */
    readonly summarize: (threadId: M.ThreadId) => Effect.Effect<string, ThreadHandoffSummaryError>;
  }
>()("t3/memory/ThreadHandoffSummary") {}

const decodeSelection = Schema.decodeUnknownEffect(M.MemoryModelSelection);
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(M.MemoryModelSelection));
const decodeInput = Schema.decodeUnknownEffect(M.GenerateMemorySummaryInput);
const strict = { onExcessProperty: "error" } as const;
const isSummaryError = Schema.is(ThreadHandoffSummaryError);

const classify = (cause: unknown): ThreadHandoffSummaryError => {
  if (isSummaryError(cause)) return cause;
  const detail =
    typeof cause === "object" && cause !== null && "detail" in cause ? cause.detail : undefined;
  return detail === "unsupported_operation" || detail === "route_unavailable"
    ? new ThreadHandoffSummaryError({
        reason: "unavailable",
        detail: "The memory model's provider can't write summaries.",
        cause,
      })
    : new ThreadHandoffSummaryError({ reason: "failed", cause });
};

const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const settings = yield* Settings.ServerSettingsService;
  const generation = yield* Generation.TextGeneration;
  const identity = yield* Environment.ServerEnvironmentIdentity;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* identity.getEnvironmentId;

  const summarize: ThreadHandoffSummary["Service"]["summarize"] = Effect.fn(
    "ThreadHandoffSummary.summarize",
  )(function* (threadId) {
    const snapshot = yield* settings.getSettings;
    if (!snapshot.memoryEnabled) {
      return yield* new ThreadHandoffSummaryError({
        reason: "unavailable",
        detail: "Memory is turned off in Settings.",
      });
    }
    const modelSelection = yield* decodeSelection(
      resolveMemoryModelSelection(snapshot, undefined),
      strict,
    );

    // The memory summary stands in when no message or finished run came after what it covers.
    const intentId = `${environmentId}:${threadId}:summary`;
    const through = yield* store.readLocalSummaryThroughSequence(environmentId, intentId);
    if (through !== undefined) {
      const newer =
        yield* sql`SELECT 1 FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${threadId} AND sequence>${through} AND (event_type='message.updated' OR (event_type='run.updated' AND json_extract(payload_json,'$.status') IN ('completed','failed','interrupted','cancelled','rolled_back'))) LIMIT 1`;
      if (newer.length === 0) {
        const payload = yield* store.readLocalSummaryPayload(environmentId, intentId);
        if (payload !== undefined) return payload.text;
      }
    }

    const ends = yield* sql<{ readonly sequence: number; readonly event_id: string }>`
      SELECT sequence, event_id FROM orchestration_events
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${threadId}
      ORDER BY sequence ASC LIMIT 1`;
    const newest = yield* sql<{ readonly sequence: number; readonly event_id: string }>`
      SELECT sequence, event_id FROM orchestration_events
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${threadId}
      ORDER BY sequence DESC LIMIT 1`;
    if (ends[0] === undefined || newest[0] === undefined) {
      return yield* new ThreadHandoffSummaryError({ reason: "failed" });
    }
    const watermark = {
      fromEventId: M.EventId.make(ends[0].event_id),
      toEventId: M.EventId.make(newest[0].event_id),
      throughSequence: newest[0].sequence,
    };
    const sourceThread = { environmentId, threadId };
    const generate = generation.generateMemorySummary;
    if (generate === undefined) {
      return yield* new ThreadHandoffSummaryError({
        reason: "unavailable",
        detail: "The memory model's provider can't write summaries.",
      });
    }
    const readFrom = (afterSequence: number) =>
      readEligibleSourceRows(sql, {
        threadId,
        afterSequence,
        throughSequence: watermark.throughSequence,
        observedSequence: watermark.throughSequence,
        excluded: [],
        limit: 102,
      }).pipe(
        Effect.flatMap((rows) => boundSourcePage(rows, watermark)),
        Effect.mapError(classify),
      );

    const generated = yield* Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-summary-" });
        return yield* generateSummaryChunks({
          first: yield* readFrom(0),
          throughSequence: watermark.throughSequence,
          previousSummary: undefined,
          dependencies: [],
          promote: false,
          buildInput: (chunk, previous) =>
            decodeInput(
              {
                cwd,
                sourceThread,
                sourceWatermark: chunk.watermark,
                messages: chunk.messages,
                ...(previous ? { previousSummary: previous } : {}),
                modelSelection,
              },
              strict,
            ).pipe(Effect.mapError(classify)),
          readFrom: (afterSequence) => readFrom(afterSequence),
          renewClaim: Effect.void,
          generate: (input) => generate(input).pipe(Effect.mapError(classify)),
          sameExecution: (execution) =>
            execution.environmentId === environmentId &&
            execution.providerInstanceId === modelSelection.instanceId &&
            encodeSelection(execution.requestedModelSelection) === encodeSelection(modelSelection),
        });
      }),
    );
    // A model that finds nothing worth keeping is a failure here: the handoff asked for a summary.
    if (generated.summary === undefined) {
      return yield* new ThreadHandoffSummaryError({ reason: "failed" });
    }
    return generated.summary.output.result.text;
  }, Effect.mapError(classify));

  return ThreadHandoffSummary.of({ summarize });
});

export const layer = Layer.effect(ThreadHandoffSummary, make);
