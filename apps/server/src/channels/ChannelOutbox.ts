import { ChannelOutboundMessage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
const PERMANENT_ERROR_CODES = new Set([
  "automation_denied",
  "messages_not_signed_in",
  "chat_not_found",
]);

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
  }
>()("t3/channels/ChannelOutbox") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const wakeups = yield* Queue.sliding<void>(1);
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

  const deliver = Effect.fn("ChannelOutbox.deliver")(function* (row: OutboxRow) {
    const message = decodeMessage(row.message_json);
    const transport = yield* registry.resolve(message.destination.kind);
    if (Option.isNone(transport)) {
      const next = yield* inSeconds(NO_TRANSPORT_RETRY_SECONDS);
      return yield* sql`UPDATE channel_outbox SET next_attempt_at = ${next} WHERE delivery_id = ${row.delivery_id}`;
    }
    const exit = yield* Effect.exit(transport.value.send(message));
    if (Exit.isSuccess(exit)) {
      return yield* sql`
        UPDATE channel_outbox
        SET state = 'sent', external_message_id = ${exit.value.externalMessageId ?? null}, last_error_code = NULL
        WHERE delivery_id = ${row.delivery_id}`;
    }
    const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
    const code = failure?.deliveryErrorCode ?? failure?.reason ?? "unknown";
    // A timeout may have posted: resending could duplicate, so it is left for a person to judge.
    if (failure?.deliveryOutcome === "unknown")
      return yield* finish(row.delivery_id, "ambiguous", code);
    if (PERMANENT_ERROR_CODES.has(code)) return yield* finish(row.delivery_id, "failed", code);
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      yield* sql`UPDATE channel_outbox SET attempts = ${attempts} WHERE delivery_id = ${row.delivery_id}`;
      return yield* finish(row.delivery_id, "failed", code);
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

  return { enqueue, find, wake, drain, start } satisfies ChannelOutbox["Service"];
});

export const layer = Layer.effect(ChannelOutbox, make);
