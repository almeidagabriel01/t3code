import { assert, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  type ChannelInboundMessage,
  type ChannelReplyAddress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ChannelGateway } from "../ChannelGateway.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import { fingerprintText } from "./imessageAdmission.ts";
import { ImessageDbError, type ImessageChatDb, type ImessageRow } from "./imessageChatDb.ts";
import * as Runtime from "./ImessageChannelRuntime.ts";
import type { ImessageSender } from "./imessageSender.ts";

const FRIEND = "+15550000001";
const ME = "+15550000002";
const NOW_MS = 1_800_000_000_000;
const DATE = (NOW_MS - 978_307_200_000) * 1_000_000;
const config = { allowedHandles: [FRIEND], selfHandles: [ME] };

const friendRow = (rowid: number, patch: Partial<ImessageRow> = {}): ImessageRow => ({
  rowid,
  guid: `guid-${rowid}`,
  text: `message ${rowid}`,
  attributedBody: null,
  is_from_me: 0,
  date: DATE + rowid,
  associated_message_type: 0,
  item_type: 0,
  balloon_bundle_id: null,
  cache_has_attachments: 0,
  message_service: "iMessage",
  sender_handle: FRIEND,
  sender_service: "iMessage",
  chat_guid: `iMessage;-;${FRIEND}`,
  chat_identifier: FRIEND,
  style: 45,
  chat_join_count: 1,
  account: null,
  ...patch,
});
const selfRow = (rowid: number, patch: Partial<ImessageRow> = {}) =>
  friendRow(rowid, {
    is_from_me: 1,
    sender_handle: null,
    sender_service: null,
    chat_guid: `iMessage;-;${ME}`,
    chat_identifier: ME,
    ...patch,
  });

const harness = () => {
  const rows: ImessageRow[] = [];
  const state = {
    openFailure: undefined as ImessageDbError["category"] | undefined,
    queryFails: false,
    ingestFails: false,
    opens: 0,
    closes: 0,
  };
  const ingested: ChannelInboundMessage[] = [];
  const sends: Array<{ chatGuid: string; text: string }> = [];
  const sendScript = {
    failure: undefined as { outcome: "not_sent"; code: "automation_denied" } | undefined,
  };
  const db: ImessageChatDb = {
    maxRowId: Effect.suspend(() =>
      state.queryFails
        ? Effect.fail(new ImessageDbError({ category: "database_unavailable" }))
        : Effect.succeed(Math.max(0, ...rows.map((row) => row.rowid))),
    ),
    rowsAfter: (cursor, limit) =>
      Effect.succeed(rows.filter((row) => row.rowid > cursor).slice(0, limit)),
    rowById: (id) => Effect.succeed(rows.find((row) => row.rowid === id)),
    close: Effect.sync(() => void (state.closes += 1)),
  };
  const sender: ImessageSender = {
    sendText: async (input) => {
      sends.push(input);
      return sendScript.failure ?? { acceptedAt: "2026-01-01T00:00:00.000Z" };
    },
  };
  const gateway = Layer.succeed(
    ChannelGateway,
    ChannelGateway.of({
      ingest: (message) =>
        state.ingestFails
          ? Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }))
          : Effect.sync(() => void ingested.push(message)),
    }),
  );
  const layer = Layer.mergeAll(gateway, ChannelTransport.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const start = (platform: NodeJS.Platform = "darwin", autoPoll = false) =>
    Runtime.make({
      openDb: Effect.suspend(() => {
        state.opens += 1;
        return state.openFailure === undefined
          ? Effect.succeed(db)
          : Effect.fail(new ImessageDbError({ category: state.openFailure }));
      }),
      sender,
      platform,
      autoPoll,
    });
  return { rows, state, ingested, sends, sendScript, layer, start };
};

const cursorRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly cursor: number;
    readonly pending_json: string;
  }>`SELECT cursor, pending_json FROM imessage_cursor`;
  return row === undefined
    ? undefined
    : { cursor: row.cursor, pending: JSON.parse(row.pending_json) };
});

it.effect(
  "starts at the newest row, so history is never replayed, then reads only what is new",
  () => {
    const { rows, ingested, layer, start } = harness();
    return Effect.gen(function* () {
      const runtime = yield* start();
      rows.push(friendRow(1), friendRow(2));
      yield* runtime.pollOnce;
      assert.lengthOf(ingested, 0);
      yield* runtime.apply(config);
      yield* runtime.pollOnce;
      assert.deepEqual(yield* cursorRow, { cursor: 2, pending: [] });
      assert.lengthOf(ingested, 0);

      rows.push(
        friendRow(3),
        friendRow(4, { sender_handle: "+15559999999" }),
        friendRow(5, { associated_message_type: 2000 }),
        selfRow(6, { chat_guid: `iMessage;-;${FRIEND}`, chat_identifier: FRIEND }),
      );
      yield* runtime.pollOnce;
      yield* runtime.pollOnce;
      assert.deepEqual(
        ingested.map((message) => [message.idempotencyKey, message.conversationKey, message.text]),
        [["imessage:guid-3", `iMessage;-;${FRIEND}`, "message 3"]],
      );
      assert.deepEqual(yield* cursorRow, { cursor: 6, pending: [] });
      yield* runtime.apply(null);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "keeps a row that has no chat yet pending, delivers it once joined, and survives a restart",
  () => {
    const { rows, state, ingested, layer, start } = harness();
    return Effect.gen(function* () {
      const first = yield* start();
      yield* first.apply(config);
      yield* first.pollOnce;
      rows.push(friendRow(1, { chat_join_count: 0 }));
      yield* first.pollOnce;
      assert.lengthOf(ingested, 0);
      assert.deepEqual(yield* cursorRow, { cursor: 1, pending: [1] });

      // A restart: a new runtime reads the stored cursor and pending set.
      const second = yield* start();
      yield* second.apply(config);
      yield* second.pollOnce;
      assert.deepEqual(yield* cursorRow, { cursor: 1, pending: [1] });
      rows[0] = friendRow(1);
      yield* second.pollOnce;
      assert.deepEqual(
        ingested.map((message) => message.text),
        ["message 1"],
      );
      assert.deepEqual(yield* cursorRow, { cursor: 1, pending: [] });
      assert.equal(state.opens, state.closes);

      // A pending row that vanished is dropped instead of blocking the channel.
      rows.push(friendRow(2, { chat_join_count: 0 }), friendRow(3, { item_type: 1 }));
      yield* second.pollOnce;
      assert.deepEqual(yield* cursorRow, { cursor: 3, pending: [2] });
      rows.splice(1, 1);
      yield* second.pollOnce;
      assert.deepEqual(yield* cursorRow, { cursor: 3, pending: [] });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "stops reading at the pending limit and recovers when the database ids go backwards",
  () => {
    const { rows, ingested, layer, start } = harness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runtime = yield* start();
      yield* runtime.apply(config);
      yield* runtime.pollOnce;
      for (let id = 1; id <= 129; id++) rows.push(friendRow(id, { chat_join_count: 0 }));
      const store = (cursor: number, pendingCount: number) =>
        sql`INSERT OR REPLACE INTO imessage_cursor (id, cursor, pending_json)
          VALUES ('imessage', ${cursor}, ${JSON.stringify(Array.from({ length: pendingCount }, (_, i) => i + 1))})`;

      yield* store(128, 128);
      yield* runtime.pollOnce;
      assert.equal((yield* cursorRow)!.cursor, 128);

      yield* store(127, 127);
      yield* runtime.pollOnce;
      const stopped = (yield* cursorRow)!;
      assert.deepEqual([stopped.cursor, stopped.pending.length], [128, 128]);
      assert.lengthOf(ingested, 0);

      yield* store(5000, 0);
      yield* runtime.pollOnce;
      assert.deepEqual(yield* cursorRow, { cursor: 129, pending: [] });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a message the gateway could not store is tried again on the next poll", () => {
  const { rows, state, ingested, layer, start } = harness();
  return Effect.gen(function* () {
    const runtime = yield* start();
    yield* runtime.apply(config);
    yield* runtime.pollOnce;
    rows.push(friendRow(1));
    state.ingestFails = true;
    yield* runtime.pollOnce;
    assert.lengthOf(ingested, 0);
    assert.equal((yield* cursorRow)!.cursor, 0);
    assert.equal((yield* runtime.status).status, "running");
    state.ingestFails = false;
    yield* runtime.pollOnce;
    assert.lengthOf(ingested, 1);
    assert.equal((yield* cursorRow)!.cursor, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("the chat with yourself never reads the transport's own replies back", () => {
  const { rows, ingested, layer, start } = harness();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtime = yield* start();
    yield* runtime.apply(config);
    yield* runtime.pollOnce;
    const reply = "Jarvis: on it";
    yield* sql`INSERT INTO imessage_sent (delivery_id, chunk_index, chat_guid, text_hash, sent_at_ms)
      VALUES ('d', 0, ${`iMessage;-;${ME}`}, ${fingerprintText(reply)}, ${NOW_MS})`;
    const mirrored = (rowid: number, text: string) =>
      selfRow(rowid, { is_from_me: 0, sender_handle: ME, sender_service: "iMessage", text });
    rows.push(
      selfRow(1, { text: "do the thing" }),
      mirrored(2, "do the thing"),
      selfRow(3, { text: reply }),
      mirrored(4, reply),
    );
    yield* runtime.pollOnce;
    assert.deepEqual(
      ingested.map((message) => message.text),
      ["do the thing"],
    );
    const [used] = yield* sql<{ readonly consumed: number }>`SELECT consumed FROM imessage_sent`;
    assert.equal(used!.consumed, 1);
    assert.equal((yield* sql`SELECT * FROM imessage_seen`).length, 2);
  }).pipe(Effect.provide(layer));
});

it.effect("reports why it cannot read, recovers, and goes quiet when disabled", () => {
  const { rows, state, layer, start } = harness();
  return Effect.gen(function* () {
    const runtime = yield* start();
    assert.deepEqual(yield* runtime.status, { status: "disabled" });
    yield* runtime.apply(config);
    assert.deepEqual(yield* runtime.status, { status: "running" });
    for (const category of [
      "full_disk_access_missing",
      "messages_not_signed_in",
      "database_unavailable",
    ] as const) {
      state.openFailure = category;
      yield* runtime.pollOnce;
      assert.deepEqual(yield* runtime.status, { status: "error", lastError: category });
      assert.equal(yield* runtime.checkAccess, category);
    }
    state.openFailure = undefined;
    state.queryFails = true;
    yield* runtime.pollOnce;
    assert.deepEqual(yield* runtime.status, { status: "error", lastError: "database_unavailable" });
    assert.equal(yield* runtime.checkAccess, "database_unavailable");
    state.queryFails = false;
    rows.push(friendRow(1));
    yield* runtime.pollOnce;
    assert.deepEqual(yield* runtime.status, { status: "running" });
    assert.equal(yield* runtime.checkAccess, "ok");
    // Only opens that failed leave nothing to close.
    assert.equal(state.opens, state.closes + 6);

    yield* runtime.apply(null);
    const opens = state.opens;
    yield* runtime.pollOnce;
    assert.equal(state.opens, opens);
    assert.deepEqual(yield* runtime.status, { status: "disabled" });
    const events = yield* Stream.runCollect(Stream.take(runtime.streamStatus, 1));
    assert.deepEqual(events, [{ status: "disabled" }]);
  }).pipe(Effect.provide(layer));
});

it.effect("a send that Messages refuses shows as an error until one goes through", () => {
  const { sends, sendScript, layer, start } = harness();
  return Effect.gen(function* () {
    const runtime = yield* start();
    const registry = yield* ChannelTransport.ChannelTransportRegistry;
    const transport = Option.getOrThrow(yield* registry.resolve("imessage"));
    const address: ChannelReplyAddress = {
      kind: "imessage",
      connectionId: Runtime.IMESSAGE_CONNECTION_ID,
      chatGuid: `iMessage;-;${FRIEND}`,
    };
    const message = (deliveryId: string) => ({
      deliveryId,
      destination: address,
      senderName: "Jarvis",
      text: "hi",
    });
    const refused = yield* Effect.flip(transport.send(message("early")));
    assert.equal(refused.reason, "adapter_unavailable");

    yield* runtime.apply(config);
    sendScript.failure = { outcome: "not_sent", code: "automation_denied" };
    const denied = yield* Effect.flip(transport.send(message("a")));
    assert.equal(denied.deliveryErrorCode, "automation_denied");
    const status = yield* runtime.status;
    assert.deepEqual(
      [status.status, status.lastError, status.lastDeliveryError?.code],
      ["error", "automation_denied", "automation_denied"],
    );
    // A database problem is shown ahead of the send problem, and both clear on their own.
    sendScript.failure = undefined;
    yield* transport.send(message("a"));
    assert.deepEqual(yield* runtime.status, { status: "running" });
    assert.lengthOf(sends, 2);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "registers no transport away from a Mac and replaces the poller when applied again",
  () => {
    const { layer, start, state } = harness();
    return Effect.gen(function* () {
      const registry = yield* ChannelTransport.ChannelTransportRegistry;
      const runtime = yield* start("linux", true);
      assert.isTrue(Option.isNone(yield* registry.resolve("imessage")));
      yield* runtime.apply(config);
      yield* runtime.apply({ allowedHandles: [], selfHandles: [ME] });
      yield* runtime.pollOnce;
      assert.isAbove(state.opens, 0);
      yield* runtime.apply(null);
    }).pipe(Effect.provide(layer));
  },
);
