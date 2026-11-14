import { type ChannelKind, ChannelOutboundMessage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import { redactChannelText } from "./channelRedaction.ts";
import * as ChannelTransport from "./ChannelTransport.ts";

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_SECONDS = 300;
const NO_TRANSPORT_RETRY_SECONDS = 30;
/** The worker also looks on this interval, so a wake lost between a commit and its offer is brief. */
const IDLE_CHECK = "10 seconds";
const PERMANENT_ERROR_CODES = ["automation_denied", "messages_not_signed_in", "chat_not_found"];
/** Matches the transports' record of confirmed pieces, so a requeue never repeats one. */
const REQUEUE_WINDOW_HOURS = 24;

const MessageJson = Schema.fromJsonString(ChannelOutboundMessage);
const decodeMessage = Schema.decodeSync(MessageJson);
const encodeMessage = Schema.encodeSync(MessageJson);

type OutboxState = "pending" | "sent" | "failed" | "ambiguous";

interface OutboxRow {
  readonly delivery_id: string;
  readonly message_json: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly external_message_id: string | null;
  readonly last_error_code: string | null;
}

/**
 * Forgets old records of sent pieces, but keeps those of a delivery still waiting or undelivered:
 * they are what keeps a later retry or resend from repeating a piece that already arrived.
 */
export const forgetSentPieces = (
  sql: SqlClient.SqlClient,
  table: "telegram_sent" | "imessage_sent",
  beforeMs: number,
) =>
  sql`
    DELETE FROM ${sql(table)} WHERE sent_at_ms < ${beforeMs}
      AND delivery_id NOT IN (SELECT delivery_id FROM channel_outbox WHERE state != 'sent')`.pipe(
    Effect.asVoid,
    Effect.orDie,
  );

/** Adds the channel's undelivered count to each status a settings service streams. */
export const withUndeliveredCount = <S extends object>(
  outbox: ChannelOutbox["Service"],
  kind: ChannelKind,
  status: Stream.Stream<S>,
) =>
  Stream.zipLatest(status, outbox.undeliveredCount(kind)).pipe(
    Stream.map(([current, count]) =>
      count === 0 ? current : { ...current, undeliveredCount: count },
    ),
  );

/** The channel's undelivered count as a status field; nothing when there are none. */
export const undeliveredField = Effect.fn("ChannelOutbox.undeliveredField")(function* (
  outbox: ChannelOutbox["Service"],
  kind: ChannelKind,
) {
  const count = Option.getOrElse(yield* Stream.runHead(outbox.undeliveredCount(kind)), () => 0);
  return count === 0 ? {} : { undeliveredCount: count };
});

export class ChannelOutbox extends Context.Service<
  ChannelOutbox,
  {
    /** Stores one delivery; a repeat of the same `deliveryId` changes nothing. */
    readonly enqueue: (message: ChannelOutboundMessage) => Effect.Effect<void>;
    readonly find: (deliveryId: string) => Effect.Effect<Option.Option<OutboxRow>>;
    /** Wakes the worker; `enqueue` does this itself, a caller that enqueues in a transaction calls it after commit. */
    readonly wake: Effect.Effect<void>;
    /** Sends every row that is due now, once, in creation order. */
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** How many deliveries to this kind of channel ran out of tries; current value first. */
    readonly undeliveredCount: (kind: ChannelKind) => Stream.Stream<number>;
    /**
     * Puts the undelivered messages of this kind back in line; returns how many. `recentOnly`
     * keeps to the last day, so an agent never revives a stale reply the user did not ask for.
     */
    readonly resend: (
      kind: ChannelKind,
      options?: { readonly recentOnly?: boolean },
    ) => Effect.Effect<number>;
  }
>()("t3/channels/ChannelOutbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const wakeups = yield* Queue.sliding<void>(1);
  const undelivered = yield* SubscriptionRef.make<ReadonlyMap<string, number>>(new Map());
  const lock = yield* Semaphore.make(1);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const inSeconds = (seconds: number) =>
    DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.add(now, { seconds }))));

  const wake = Queue.offer(wakeups, undefined).pipe(Effect.asVoid);

  const enqueue: ChannelOutbox["Service"]["enqueue"] = Effect.fn("ChannelOutbox.enqueue")(
    function* (written) {
      // The one way out to a chat app: whoever wrote it, nothing recognizable as a credential
      // is stored here or reaches a third-party server.
      const message = {
        ...written,
        text: redactChannelText(written.text),
        ...(written.choices === undefined
          ? {}
          : {
              choices: written.choices.map((choice) => ({
                ...choice,
                label: redactChannelText(choice.label),
              })),
            }),
      };
      const now = yield* nowIso;
      yield* sql`
        INSERT OR IGNORE INTO channel_outbox (
          delivery_id, message_json, state, next_attempt_at, created_at
        ) VALUES (
          ${message.deliveryId}, ${encodeMessage(message)}, 'pending', ${now}, ${now}
        )`;
      yield* wake;
    },
    Effect.orDie,
  );

  const find: ChannelOutbox["Service"]["find"] = (deliveryId) =>
    sql<OutboxRow>`SELECT * FROM channel_outbox WHERE delivery_id = ${deliveryId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.orDie,
    );

  const finish = (id: string, state: OutboxState, code: string | null) =>
    sql`UPDATE channel_outbox SET state = ${state}, last_error_code = ${code} WHERE delivery_id = ${id}`;

  const kindOf = sql.literal(`json_extract(message_json, '$.destination.kind')`);

  const countUndelivered = Effect.gen(function* () {
    const rows = yield* sql<{ readonly kind: string; readonly count: number }>`
      SELECT ${kindOf} AS kind, COUNT(*) AS count FROM channel_outbox
      WHERE state IN ('failed', 'ambiguous') GROUP BY kind`;
    const next = new Map(rows.map((row) => [row.kind, row.count]));
    const current = yield* SubscriptionRef.get(undelivered);
    const same =
      current.size === next.size && [...next].every(([kind, n]) => current.get(kind) === n);
    if (!same) yield* SubscriptionRef.set(undelivered, next);
  });

  /**
   * Once a send to a channel works again, what ran out of tries there for a passing reason goes
   * back in line, once per delivery, so a message that keeps failing never loops.
   */
  const requeueAfterRecovery = Effect.fn("ChannelOutbox.requeueAfterRecovery")(function* (
    message: ChannelOutboundMessage,
  ) {
    const now = yield* nowIso;
    const since = yield* inSeconds(-REQUEUE_WINDOW_HOURS * 3600);
    const requeued = yield* sql`
        UPDATE channel_outbox
        SET state = 'pending', attempts = 0, next_attempt_at = ${now}, auto_requeued = 1
        WHERE state IN ('failed', 'ambiguous') AND auto_requeued = 0
          AND COALESCE(last_error_code, '') NOT IN ${sql.in(PERMANENT_ERROR_CODES)}
          AND created_at >= ${since}
          AND ${kindOf} = ${message.destination.kind}
          AND json_extract(message_json, '$.destination.connectionId') = ${message.destination.connectionId}
        RETURNING delivery_id`;
    if (requeued.length > 0) yield* wake;
  });

  const deliver = Effect.fn("ChannelOutbox.deliver")(function* (row: OutboxRow) {
    const message = decodeMessage(row.message_json);
    const transport = yield* registry.resolve(message.destination.kind);
    if (Option.isNone(transport)) {
      const next = yield* inSeconds(NO_TRANSPORT_RETRY_SECONDS);
      return yield* sql`UPDATE channel_outbox SET next_attempt_at = ${next} WHERE delivery_id = ${row.delivery_id}`;
    }
    const exit = yield* Effect.exit(transport.value.send(message));
    if (Exit.isSuccess(exit)) {
      yield* sql`
        UPDATE channel_outbox
        SET state = 'sent', external_message_id = ${exit.value.externalMessageId ?? null}, last_error_code = NULL
        WHERE delivery_id = ${row.delivery_id}`;
      return yield* requeueAfterRecovery(message);
    }
    const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
    const code = failure?.deliveryErrorCode ?? failure?.reason ?? "unknown";
    if (PERMANENT_ERROR_CODES.includes(code)) return yield* finish(row.delivery_id, "failed", code);
    // A send that may have posted is tried again too: a rare duplicate beats a lost reply, and the
    // transports never repeat a piece the chat app confirmed.
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      yield* sql`UPDATE channel_outbox SET attempts = ${attempts} WHERE delivery_id = ${row.delivery_id}`;
      const state = failure?.deliveryOutcome === "unknown" ? "ambiguous" : "failed";
      return yield* finish(row.delivery_id, state, code);
    }
    const delay = Math.max(
      Math.min(2 ** attempts, MAX_BACKOFF_SECONDS),
      failure?.retryAfterSeconds ?? 0,
    );
    const next = yield* inSeconds(delay);
    yield* sql`
      UPDATE channel_outbox
      SET attempts = ${attempts}, next_attempt_at = ${next}, last_error_code = ${code}
      WHERE delivery_id = ${row.delivery_id}`;
  });

  const drain: ChannelOutbox["Service"]["drain"] = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const due = yield* sql<OutboxRow>`
          SELECT * FROM channel_outbox
          WHERE state = 'pending' AND next_attempt_at <= ${now} ORDER BY rowid`;
        // One bad row never holds back the rest.
        yield* Effect.forEach(
          due,
          (row) =>
            deliver(row).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("channel delivery skipped", {
                  deliveryId: row.delivery_id,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
        yield* countUndelivered;
      }),
    )
    .pipe(
      Effect.catchCause((cause) => Effect.logWarning("channel outbox drain failed", { cause })),
      Effect.withSpan("ChannelOutbox.drain"),
    );

  const start: ChannelOutbox["Service"]["start"] = () =>
    forkParked(
      drain.pipe(
        Effect.andThen(Effect.race(Queue.take(wakeups), Effect.sleep(IDLE_CHECK))),
        Effect.forever,
      ),
    );

  const undeliveredCount: ChannelOutbox["Service"]["undeliveredCount"] = (kind) =>
    SubscriptionRef.changes(undelivered).pipe(
      Stream.map((counts) => counts.get(kind) ?? 0),
      Stream.changes,
    );

  const resend: ChannelOutbox["Service"]["resend"] = Effect.fn("ChannelOutbox.resend")(function* (
    kind,
    options,
  ) {
    const now = yield* nowIso;
    const since = options?.recentOnly ? yield* inSeconds(-REQUEUE_WINDOW_HOURS * 3600) : "";
    const requeued = yield* sql`
        UPDATE channel_outbox SET state = 'pending', attempts = 0, next_attempt_at = ${now}
        WHERE state IN ('failed', 'ambiguous') AND ${kindOf} = ${kind} AND created_at >= ${since}
        RETURNING delivery_id`;
    yield* countUndelivered;
    yield* wake;
    return requeued.length;
  }, Effect.orDie);

  return {
    enqueue,
    find,
    wake,
    drain,
    start,
    undeliveredCount,
    resend,
  } satisfies ChannelOutbox["Service"];
});

export const layer = Layer.effect(ChannelOutbox, make);
