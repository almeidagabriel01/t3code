/**
 * Polls the Mac's Messages database for new rows and hands the admitted ones to the gateway.
 * The cursor (a ROWID) and the rows still waiting for their chat are stored, so a restart
 * neither replays history nor loses a message that arrived while the server was off.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the local Messages path is fixed for this adapter.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ImessageChannelAccess,
  ImessageChannelDeliveryError,
  ImessageChannelErrorCode,
  ImessageChannelStatusEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import {
  admitImessageRow,
  OWN_REPLY_WINDOW_MS,
  toImessageInbound,
  type ImessageAdmission,
  type ImessageAdmissionMemory,
} from "./imessageAdmission.ts";
import {
  ImessageDbError,
  openImessageChatDb,
  type ImessageChatDb,
  type ImessageRow,
} from "./imessageChatDb.ts";
import { makeOsascriptImessageSender, type ImessageSender } from "./imessageSender.ts";
import { makeImessageTransport, type ImessageSendReport } from "./imessageTransport.ts";

export const IMESSAGE_CONNECTION_ID = "imessage";
const POLL_INTERVAL = "2 seconds";
const BATCH = 50;
const PENDING_CAP = 128;
const SENT_RETENTION_MS = 24 * 60 * 60_000;
const SEEN_KEEP = 200;

export interface ImessageConfig {
  readonly allowedHandles: ReadonlyArray<string>;
  readonly selfHandles: ReadonlyArray<string>;
}

export type ImessageRuntimeStatus = ImessageChannelStatusEvent;

const DISABLED: ImessageRuntimeStatus = { status: "disabled" };

export class ImessageChannelRuntime extends Context.Service<
  ImessageChannelRuntime,
  {
    /** Starts polling with this configuration, replacing the previous one; `null` stops it. */
    readonly apply: (config: ImessageConfig | null) => Effect.Effect<void>;
    readonly status: Effect.Effect<ImessageRuntimeStatus>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<ImessageRuntimeStatus>;
    /** Reads chat.db once, read-only, to show whether the permission is granted. */
    readonly checkAccess: Effect.Effect<ImessageChannelAccess>;
    /** One poll now; the loop calls this every two seconds. */
    readonly pollOnce: Effect.Effect<void>;
  }
>()("t3/channels/imessage/ImessageChannelRuntime") {}

const PendingJson = Schema.fromJsonString(Schema.Array(Schema.Int));
const decodePending = Schema.decodeUnknownSync(PendingJson);
const encodePending = Schema.encodeSync(PendingJson);

interface Cursor {
  readonly cursor: number;
  readonly pendingRowIds: ReadonlyArray<number>;
}

export interface ImessageRuntimeOptions {
  readonly openDb: Effect.Effect<ImessageChatDb, ImessageDbError>;
  readonly sender: ImessageSender;
  readonly platform?: NodeJS.Platform;
  /** Tests turn the two-second loop off and call `pollOnce` themselves. */
  readonly autoPoll?: boolean;
}

export const make = Effect.fn("ImessageChannelRuntime.make")(function* (
  options: ImessageRuntimeOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const layerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const config = yield* Ref.make<ImessageConfig | null>(null);
  const loop = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const pollError = yield* Ref.make<ImessageChannelErrorCode | undefined>(undefined);
  const sendError = yield* Ref.make<ImessageChannelErrorCode | undefined>(undefined);
  const deliveryError = yield* Ref.make<ImessageChannelDeliveryError | undefined>(undefined);
  const statusRef = yield* SubscriptionRef.make<ImessageRuntimeStatus>(DISABLED);

  const publish = Effect.gen(function* () {
    if ((yield* Ref.get(config)) === null) return yield* SubscriptionRef.set(statusRef, DISABLED);
    const lastError = (yield* Ref.get(pollError)) ?? (yield* Ref.get(sendError));
    const lastDeliveryError = yield* Ref.get(deliveryError);
    yield* SubscriptionRef.set(statusRef, {
      status: lastError === undefined ? "running" : "error",
      ...(lastError === undefined ? {} : { lastError }),
      ...(lastDeliveryError === undefined ? {} : { lastDeliveryError }),
    });
  });

  const setPollError = (code: ImessageChannelErrorCode | undefined) =>
    Ref.set(pollError, code).pipe(Effect.andThen(publish));

  const report = Effect.fn("ImessageChannelRuntime.report")(function* (result: ImessageSendReport) {
    if (result.ok) {
      yield* Ref.set(sendError, undefined);
      yield* Ref.set(deliveryError, undefined);
    } else {
      yield* Ref.set(deliveryError, {
        code: result.code,
        at: DateTime.formatIso(yield* DateTime.now),
      });
      yield* Ref.set(
        sendError,
        result.code === "automation_denied" || result.code === "messages_not_signed_in"
          ? result.code
          : undefined,
      );
    }
    yield* publish;
  });

  const orDieSql = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.orDie(effect);

  if ((options.platform ?? (yield* HostProcess.Platform)) === "darwin") {
    yield* registry.register(
      makeImessageTransport({
        connectionId: IMESSAGE_CONNECTION_ID,
        sender: options.sender,
        sql,
        isActive: Effect.map(Ref.get(config), (current) => current !== null),
        report,
      }),
    );
  }

  const loadCursor = Effect.fn("ImessageChannelRuntime.loadCursor")(function* () {
    const rows = yield* sql<{ readonly cursor: number; readonly pending_json: string }>`
        SELECT cursor, pending_json FROM imessage_cursor WHERE id = ${IMESSAGE_CONNECTION_ID}`;
    const row = rows[0];
    return row === undefined
      ? undefined
      : { cursor: row.cursor, pendingRowIds: decodePending(row.pending_json) };
  }, orDieSql);

  const saveCursor = (next: Cursor) =>
    sql`
        INSERT OR REPLACE INTO imessage_cursor (id, cursor, pending_json)
        VALUES (${IMESSAGE_CONNECTION_ID}, ${next.cursor}, ${encodePending(next.pendingRowIds)})`.pipe(
      Effect.orDie,
    );

  const loadMemory = Effect.fn("ImessageChannelRuntime.loadMemory")(function* () {
    const now = (yield* DateTime.now).epochMilliseconds;
    const sent = yield* sql<{
      readonly id: number;
      readonly chat_guid: string;
      readonly text_hash: string;
      readonly sent_at_ms: number;
    }>`
        SELECT id, chat_guid, text_hash, sent_at_ms FROM imessage_sent
        WHERE consumed = 0 AND sent_at_ms > ${now - OWN_REPLY_WINDOW_MS}`;
    const seen = yield* sql<{
      readonly chat_guid: string;
      readonly text_hash: string;
      readonly date_ms: number;
    }>`SELECT chat_guid, text_hash, date_ms FROM imessage_seen`;
    return {
      sent: sent.map((row) => ({
        id: row.id,
        chatGuid: row.chat_guid,
        textHash: row.text_hash,
        sentAtMs: row.sent_at_ms,
      })),
      seen: seen.map((row) => ({
        chatGuid: row.chat_guid,
        textHash: row.text_hash,
        dateMs: row.date_ms,
      })),
    } satisfies ImessageAdmissionMemory;
  }, orDieSql);

  const rememberSelfRow = Effect.fn("ImessageChannelRuntime.rememberSelfRow")(function* (
    admission: ImessageAdmission,
  ) {
    if (admission.type === "pending_join" || admission.remember === undefined) return;
    const { chatGuid, textHash, dateMs } = admission.remember;
    if (admission.type === "skip" && admission.consumeSentId !== undefined) {
      yield* sql`UPDATE imessage_sent SET consumed = 1 WHERE id = ${admission.consumeSentId}`;
    }
    yield* sql`
          INSERT INTO imessage_seen (chat_guid, text_hash, date_ms)
          VALUES (${chatGuid}, ${textHash}, ${dateMs})`;
    yield* sql`
          DELETE FROM imessage_seen
          WHERE id <= (SELECT MAX(id) FROM imessage_seen) - ${SEEN_KEEP}`;
  }, Effect.orDie);

  /** Admits one row and passes it on; a gateway failure leaves the cursor where it was. */
  const ingestRow = Effect.fn("ImessageChannelRuntime.ingestRow")(function* (row: ImessageRow) {
    const current = yield* Ref.get(config);
    if (current === null) return undefined;
    const admission = admitImessageRow(
      row,
      {
        allowedHandles: new Set(current.allowedHandles),
        selfHandles: new Set(current.selfHandles),
      },
      yield* loadMemory(),
    );
    if (admission.type === "message") {
      yield* gateway.ingest(toImessageInbound(admission, IMESSAGE_CONNECTION_ID));
    }
    yield* rememberSelfRow(admission);
    return admission;
  });

  const processDb = Effect.fn("ImessageChannelRuntime.processDb")(function* (db: ImessageChatDb) {
    const max = yield* db.maxRowId;
    let state = yield* loadCursor();
    if (state === undefined || max < state.cursor) {
      // First enable, or a replaced database: start from now, never from history.
      if (state !== undefined) yield* Effect.logWarning("iMessage database ROWID went backwards");
      yield* saveCursor({ cursor: max, pendingRowIds: [] });
      return;
    }
    for (const id of state.pendingRowIds) {
      const row = yield* db.rowById(id);
      const admission = row === undefined ? undefined : yield* ingestRow(row);
      if (admission?.type === "pending_join") continue;
      state = {
        cursor: state.cursor,
        pendingRowIds: state.pendingRowIds.filter((v) => v !== id),
      };
      yield* saveCursor(state);
    }
    if (state.pendingRowIds.length >= PENDING_CAP) {
      return yield* Effect.logWarning("iMessage pending join limit reached");
    }
    for (const row of yield* db.rowsAfter(state.cursor, BATCH)) {
      const admission = yield* ingestRow(row);
      if (admission?.type === "pending_join" && state.pendingRowIds.length >= PENDING_CAP) {
        return yield* Effect.logWarning("iMessage pending join limit reached");
      }
      state = {
        cursor: row.rowid,
        pendingRowIds:
          admission?.type === "pending_join"
            ? [...state.pendingRowIds, row.rowid]
            : state.pendingRowIds,
      };
      yield* saveCursor(state);
    }
    const now = (yield* DateTime.now).epochMilliseconds;
    yield* sql`DELETE FROM imessage_sent WHERE sent_at_ms < ${now - SENT_RETENTION_MS}`.pipe(
      Effect.orDie,
    );
  });

  const pollOnce: ImessageChannelRuntime["Service"]["pollOnce"] = Effect.gen(function* () {
    if ((yield* Ref.get(config)) === null) return;
    const opened = yield* Effect.result(options.openDb);
    if (opened._tag === "Failure") return yield* setPollError(opened.failure.category);
    const db = opened.success;
    const outcome = yield* processDb(db).pipe(Effect.ensuring(db.close), Effect.result);
    if (outcome._tag === "Success") return yield* setPollError(undefined);
    if (outcome.failure._tag === "ImessageDbError") {
      return yield* setPollError(outcome.failure.category);
    }
    // The gateway could not store the message; the next poll tries the same row again.
    yield* Effect.logWarning("iMessage message was not stored; retrying next poll", {
      failure: outcome.failure,
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("iMessage poll failed", { cause })),
    Effect.withSpan("ImessageChannelRuntime.pollOnce"),
  );

  const apply: ImessageChannelRuntime["Service"]["apply"] = (next) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(loop);
        if (previous !== undefined) yield* Fiber.interrupt(previous);
        yield* Ref.set(loop, undefined);
        yield* Ref.set(config, next);
        yield* Ref.set(pollError, undefined);
        yield* Ref.set(sendError, undefined);
        yield* Ref.set(deliveryError, undefined);
        yield* publish;
        if (next === null || options.autoPoll === false) return;
        const fiber = yield* Effect.forkIn(
          pollOnce.pipe(Effect.andThen(Effect.sleep(POLL_INTERVAL)), Effect.forever),
          layerScope,
        );
        yield* Ref.set(loop, fiber);
      }),
    );

  const checkAccess: ImessageChannelRuntime["Service"]["checkAccess"] = options.openDb.pipe(
    Effect.flatMap((db) => db.maxRowId.pipe(Effect.ensuring(db.close))),
    Effect.as("ok" as const),
    Effect.catch((failure) => Effect.succeed(failure.category)),
  );

  return ImessageChannelRuntime.of({
    apply,
    status: SubscriptionRef.get(statusRef),
    streamStatus: SubscriptionRef.changes(statusRef),
    checkAccess,
    pollOnce,
  });
});

const defaultChatDbPath = () => NodePath.join(NodeOS.homedir(), "Library/Messages/chat.db");

export const layer = Layer.effect(
  ImessageChannelRuntime,
  make({
    openDb: Effect.suspend(() => openImessageChatDb(defaultChatDbPath())),
    sender: makeOsascriptImessageSender(),
  }),
);
