import {
  CommandId,
  DECISION_CONTEXT_MAX_LENGTH,
  DECISION_MAX_OPTIONS,
  DECISION_OPTION_CONSEQUENCE_MAX_LENGTH,
  DECISION_OPTION_LABEL_MAX_LENGTH,
  DECISION_TITLE_MAX_LENGTH,
  Decision,
  DecisionAnswer,
  DecisionError,
  DecisionId,
  DecisionOption,
  MessageId,
  type DecisionsAnswerInput,
  type DecisionsEvent,
  type DecisionsListInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** Settled decisions kept in a list or snapshot; open ones are never cut. */
const RECENT_SETTLED_LIMIT = 50;
const SWEEP_INTERVAL = "30 seconds";
/** A send that keeps failing for another reason than a gone thread stops after this many tries. */
const MAX_DELIVERY_ATTEMPTS = 20;
const MAX_EXPIRES_IN_MINUTES = 60 * 24 * 30;

interface DecisionRow {
  readonly decision_id: string;
  readonly from_thread_id: string;
  readonly project_id: string;
  readonly thread_title: string;
  readonly title: string;
  readonly context: string;
  readonly options_json: string;
  readonly recommended: string | null;
  readonly expires_at: string | null;
  readonly status: Decision["status"];
  readonly answer_json: string | null;
  readonly answered_at: string | null;
  readonly delivered_at: string | null;
  readonly created_at: string;
}

export interface DecisionRequestInput {
  readonly fromThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  /** With the thread, identifies the request: a repeat returns the first decision. */
  readonly clientRequestId: string;
  readonly title: string;
  readonly context: string;
  readonly options: ReadonlyArray<DecisionOption>;
  readonly recommended?: string | undefined;
  readonly expiresInMinutes?: number | undefined;
}

const decisionError = (reason: DecisionError["reason"], message: string) =>
  new DecisionError({ reason, message });
const invalid = (message: string) => Effect.fail(decisionError("invalid", message));

const OptionsJson = Schema.fromJsonString(Schema.Array(DecisionOption));
const AnswerJson = Schema.fromJsonString(DecisionAnswer);
const decodeOptions = Schema.decodeSync(OptionsJson);
const encodeOptions = Schema.encodeSync(OptionsJson);
const decodeAnswer = Schema.decodeSync(AnswerJson);
const encodeAnswer = Schema.encodeSync(AnswerJson);

const toDecision = (row: DecisionRow): Decision => ({
  id: DecisionId.make(row.decision_id),
  fromThreadId: row.from_thread_id as ThreadId,
  threadTitle: row.thread_title,
  title: row.title,
  context: row.context,
  options: decodeOptions(row.options_json),
  ...(row.recommended === null ? {} : { recommended: row.recommended }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  status: row.status,
  ...(row.answer_json === null ? {} : { answer: decodeAnswer(row.answer_json) }),
  ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
  ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  createdAt: row.created_at,
});

/** What the requesting agent reads. It never says "approved" for anything but a chosen option. */
const deliveryText = (row: DecisionRow): string => {
  const decision = toDecision(row);
  const head = `"${decision.title}" [decision ${decision.id}]`;
  if (decision.status === "expired") {
    return `The decision ${head} expired at ${decision.expiresAt} with no answer. Nothing was approved; do not assume approval. Continue without it or ask in chat.`;
  }
  if (decision.status === "withdrawn") {
    return `The user dismissed this decision: ${head}. No option was chosen and nothing was approved; do not assume approval. Continue without it or ask in chat.`;
  }
  const chosen = decision.options.find((option) => option.id === decision.answer?.optionId);
  return [
    `The user answered the decision ${head} at ${decision.answeredAt}.`,
    ...(chosen === undefined
      ? []
      : [
          `Chosen: ${chosen.label}${chosen.consequence === undefined ? "" : ` (${chosen.consequence})`}`,
        ]),
    ...(decision.answer?.text === undefined ? [] : [`Answer: ${decision.answer.text}`]),
  ].join("\n");
};

export class DecisionService extends Context.Service<
  DecisionService,
  {
    /** Idempotent by thread and `clientRequestId`. Never waits for the answer. */
    readonly request: (input: DecisionRequestInput) => Effect.Effect<Decision, DecisionError>;
    /** Every open decision, then the most recent settled ones; limited to a thread when given. */
    readonly list: (
      input: DecisionsListInput,
    ) => Effect.Effect<ReadonlyArray<Decision>, DecisionError>;
    readonly get: (decisionId: DecisionId) => Effect.Effect<Decision, DecisionError>;
    /** A snapshot, then one event per change. */
    readonly subscribe: Stream.Stream<DecisionsEvent, DecisionError>;
    /** Refuses a decision that is no longer open, or whose time has passed. */
    readonly answer: (input: DecisionsAnswerInput) => Effect.Effect<Decision, DecisionError>;
    /** The user declines; the agent is told, never told it was approved. */
    readonly dismiss: (decisionId: DecisionId) => Effect.Effect<Decision, DecisionError>;
    /** The requesting agent takes its question back. Repeating, or after settling, changes nothing. */
    readonly withdraw: (input: {
      readonly decisionId: DecisionId;
      readonly fromThreadId: ThreadId;
    }) => Effect.Effect<Decision, DecisionError>;
    /** Marks open decisions past `expiresAt` as expired. Delivery is a separate step. */
    readonly expireDue: Effect.Effect<void, DecisionError>;
    /** Sends each answered, dismissed or expired decision to its thread once. */
    readonly deliverPending: Effect.Effect<void, DecisionError>;
  }
>()("t3/decisions/DecisionService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const lock = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<DecisionsEvent>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const storage = <A, R>(self: Effect.Effect<A, SqlError | DecisionError, R>) =>
    self.pipe(
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.logWarning("decisions storage failed", { cause }).pipe(
            Effect.andThen(
              Effect.fail(decisionError("storage", "Could not read or write decisions.")),
            ),
          ),
      }),
    );

  const findRow = Effect.fn("DecisionService.findRow")(function* (decisionId: string) {
    const rows = yield* sql<DecisionRow>`SELECT * FROM decisions WHERE decision_id = ${decisionId}`;
    return rows[0] ?? (yield* decisionError("not_found", "Decision not found."));
  });

  const publish = (row: DecisionRow) =>
    PubSub.publish(events, { type: "upserted", decision: toDecision(row) });

  const request: DecisionService["Service"]["request"] = Effect.fn("DecisionService.request")(
    function* (input) {
      const clientRequestId = input.clientRequestId.trim();
      const title = input.title.trim();
      if (clientRequestId === "" || clientRequestId.length > 512) {
        return yield* invalid("clientRequestId must be 1-512 characters.");
      }
      if (title === "" || title.length > DECISION_TITLE_MAX_LENGTH) {
        return yield* invalid(`title must be 1-${DECISION_TITLE_MAX_LENGTH} characters.`);
      }
      if (input.context.length > DECISION_CONTEXT_MAX_LENGTH) {
        return yield* invalid(`context is over ${DECISION_CONTEXT_MAX_LENGTH} characters.`);
      }
      if (input.options.length < 1 || input.options.length > DECISION_MAX_OPTIONS) {
        return yield* invalid(`Give 1-${DECISION_MAX_OPTIONS} options.`);
      }
      const ids = new Set(input.options.map((option) => option.id));
      if (
        ids.size !== input.options.length ||
        input.options.some(
          (option) =>
            option.id.trim() === "" ||
            option.label.trim() === "" ||
            option.label.length > DECISION_OPTION_LABEL_MAX_LENGTH ||
            (option.consequence?.length ?? 0) > DECISION_OPTION_CONSEQUENCE_MAX_LENGTH,
        )
      ) {
        return yield* invalid("Options need unique ids and labels of 1-80 characters.");
      }
      if (input.recommended !== undefined && !ids.has(input.recommended)) {
        return yield* invalid("recommended must be one of the option ids.");
      }
      const minutes = input.expiresInMinutes;
      if (
        minutes !== undefined &&
        (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRES_IN_MINUTES)
      ) {
        return yield* invalid(`expiresInMinutes must be 1-${MAX_EXPIRES_IN_MINUTES}.`);
      }
      yield* Effect.annotateCurrentSpan({ "decision.thread_id": input.fromThreadId });
      const decisionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* sql<DecisionRow>`
            SELECT * FROM decisions
            WHERE from_thread_id = ${input.fromThreadId} AND client_request_id = ${clientRequestId}`;
          if (existing[0] !== undefined) return toDecision(existing[0]);
          const now = yield* DateTime.now;
          const createdAt = DateTime.formatIso(now);
          const expiresAt =
            minutes === undefined ? null : DateTime.formatIso(DateTime.add(now, { minutes }));
          yield* sql`
            INSERT INTO decisions (
              decision_id, from_thread_id, project_id, client_request_id, thread_title, title,
              context, options_json, recommended, expires_at, status, created_at
            ) VALUES (
              ${decisionId}, ${input.fromThreadId}, ${input.projectId}, ${clientRequestId},
              ${input.threadTitle.slice(0, 200)}, ${title}, ${input.context},
              ${encodeOptions(input.options)}, ${input.recommended ?? null}, ${expiresAt},
              'open', ${createdAt}
            )`;
          const row = yield* findRow(decisionId);
          yield* publish(row);
          return toDecision(row);
        }),
      );
    },
    storage,
  );

  const list: DecisionService["Service"]["list"] = Effect.fn("DecisionService.list")(function* (
    input,
  ) {
    const scope =
      input.threadId === undefined ? sql`` : sql`AND from_thread_id = ${input.threadId}`;
    const open = yield* sql<DecisionRow>`
      SELECT * FROM decisions WHERE status = 'open' ${scope} ORDER BY created_at ASC`;
    const settled = yield* sql<DecisionRow>`
      SELECT * FROM decisions WHERE status <> 'open' ${scope}
      ORDER BY COALESCE(answered_at, created_at) DESC LIMIT ${RECENT_SETTLED_LIMIT}`;
    return [...open, ...settled].map(toDecision);
  }, storage);

  const get: DecisionService["Service"]["get"] = Effect.fn("DecisionService.get")(function* (
    decisionId,
  ) {
    return toDecision(yield* findRow(decisionId));
  }, storage);

  const subscribe: DecisionService["Service"]["subscribe"] = Stream.unwrap(
    // Subscribe before the snapshot while holding the writers' lock, so no change falls between.
    lock.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(events);
        const decisions = yield* list({});
        return Stream.concat(
          Stream.succeed<DecisionsEvent>({ type: "snapshot", decisions }),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
  );

  /** Settles an open row; any other state is returned untouched for the caller to judge. */
  const settle = (decisionId: string, update: (now: string) => Effect.Effect<unknown, SqlError>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* findRow(decisionId);
        if (row.status !== "open") return { row, changed: false };
        yield* update(yield* nowIso);
        const next = yield* findRow(decisionId);
        yield* publish(next);
        return { row: next, changed: true };
      }),
    );

  const markDelivery = Effect.fn("DecisionService.markDelivery")(function* (row: DecisionRow) {
    const now = yield* nowIso;
    const result = yield* threads
      .sendToThread({
        projectId: row.project_id as ProjectId,
        // The row id is the receipt: a retry after a crash replays this send instead of repeating it.
        commandId: CommandId.make(`decision-answer:${row.decision_id}`),
        messageId: MessageId.make(`decision-answer:${row.decision_id}`),
        threadId: row.from_thread_id as ThreadId,
        text: deliveryText(row),
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (result._tag === "Success") {
      yield* sql`
        UPDATE decisions SET delivered_at = ${now}
        WHERE decision_id = ${row.decision_id} AND delivered_at IS NULL`;
    } else if (
      result.failure._tag === "ThreadManagementThreadArchivedError" ||
      result.failure._tag === "ThreadManagementThreadNotFoundError"
    ) {
      yield* sql`
        UPDATE decisions SET delivery_error = 'thread_gone'
        WHERE decision_id = ${row.decision_id} AND delivered_at IS NULL`;
    } else {
      yield* Effect.logWarning("decision delivery failed", {
        decisionId: row.decision_id,
        cause: result.failure,
      });
      yield* sql`
        UPDATE decisions SET
          delivery_attempts = delivery_attempts + 1,
          delivery_error = CASE WHEN delivery_attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS}
            THEN 'gave_up' ELSE NULL END
        WHERE decision_id = ${row.decision_id} AND delivered_at IS NULL`;
    }
    yield* publish(yield* findRow(row.decision_id));
  });

  const deliverPending: DecisionService["Service"]["deliverPending"] = Effect.gen(function* () {
    const pending = yield* sql<DecisionRow>`
      SELECT * FROM decisions
      WHERE status <> 'open' AND delivered_at IS NULL AND delivery_error IS NULL
      ORDER BY COALESCE(answered_at, created_at) ASC`;
    // One bad row never holds back the rest.
    yield* Effect.forEach(
      pending,
      (row) =>
        markDelivery(row).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("decision delivery skipped", { decisionId: row.decision_id, cause }),
          ),
        ),
      { discard: true },
    );
  }).pipe(storage, Effect.withSpan("DecisionService.deliverPending"));

  const expireDue: DecisionService["Service"]["expireDue"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const due = yield* sql<DecisionRow>`
            SELECT * FROM decisions
            WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ${now}`;
        for (const row of due) {
          yield* sql`UPDATE decisions SET status = 'expired' WHERE decision_id = ${row.decision_id}`;
          yield* publish(yield* findRow(row.decision_id));
        }
      }),
    )
    .pipe(storage, Effect.withSpan("DecisionService.expireDue"));

  const deliverQuietly = (decisionId: string) =>
    deliverPending.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("decision delivery failed", { decisionId, cause }),
      ),
    );

  const answer: DecisionService["Service"]["answer"] = Effect.fn("DecisionService.answer")(
    function* (input) {
      const optionId = input.optionId?.trim() || undefined;
      const text = input.text?.trim() || undefined;
      const row = yield* findRow(input.decisionId);
      if (row.status !== "open") {
        return yield* decisionError("not_open", `This decision is already ${row.status}.`);
      }
      const options = toDecision(row).options;
      if (optionId !== undefined && !options.some((option) => option.id === optionId)) {
        return yield* invalid("optionId is not one of this decision's options.");
      }
      if (optionId === undefined && text === undefined) {
        return yield* invalid("Choose an option or write an answer.");
      }
      const now = yield* nowIso;
      if (row.expires_at !== null && row.expires_at <= now) {
        return yield* decisionError("not_open", "This decision has expired.");
      }
      const answer = encodeAnswer({
        ...(optionId === undefined ? {} : { optionId }),
        ...(text === undefined ? {} : { text }),
      });
      const settled = yield* settle(
        input.decisionId,
        (at) =>
          sql`UPDATE decisions SET status = 'answered', answer_json = ${answer}, answered_at = ${at}
            WHERE decision_id = ${input.decisionId}`,
      );
      if (!settled.changed) {
        return yield* decisionError("not_open", `This decision is already ${settled.row.status}.`);
      }
      yield* deliverQuietly(input.decisionId);
      return toDecision(yield* findRow(input.decisionId));
    },
    storage,
  );

  const dismiss: DecisionService["Service"]["dismiss"] = Effect.fn("DecisionService.dismiss")(
    function* (decisionId) {
      const settled = yield* settle(
        decisionId,
        (at) =>
          sql`UPDATE decisions SET status = 'withdrawn', answered_at = ${at}
            WHERE decision_id = ${decisionId}`,
      );
      if (!settled.changed) {
        return yield* decisionError("not_open", `This decision is already ${settled.row.status}.`);
      }
      yield* deliverQuietly(decisionId);
      return toDecision(yield* findRow(decisionId));
    },
    storage,
  );

  const withdraw: DecisionService["Service"]["withdraw"] = Effect.fn("DecisionService.withdraw")(
    function* (input) {
      const row = yield* findRow(input.decisionId);
      if (row.from_thread_id !== input.fromThreadId) {
        return yield* decisionError("not_found", "Decision not found.");
      }
      // The agent withdrew it, so there is nothing to tell it: mark it delivered.
      const settled = yield* settle(
        input.decisionId,
        (at) =>
          sql`UPDATE decisions SET status = 'withdrawn', delivered_at = ${at}
            WHERE decision_id = ${input.decisionId}`,
      );
      return toDecision(settled.row);
    },
    storage,
  );

  const sweep = expireDue.pipe(
    Effect.andThen(deliverPending),
    Effect.catchCause((cause) => Effect.logWarning("decision sweep failed", { cause })),
  );
  // The first sweep waits a full interval so startup is not racing the services it sends through.
  yield* sweep.pipe(
    Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    Effect.delay(SWEEP_INTERVAL),
    Effect.forkScoped,
  );

  return DecisionService.of({
    request,
    list,
    get,
    subscribe,
    answer,
    dismiss,
    withdraw,
    expireDue,
    deliverPending,
  });
});

export const layer = Layer.effect(DecisionService, make);
