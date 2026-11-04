import { assert, it } from "@effect/vitest";
import { ChannelGatewayError, type ChannelInboundMessage } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ChannelGateway } from "../ChannelGateway.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import * as Runtime from "./TelegramChannelRuntime.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_secret";
const config = { token: Redacted.make(TOKEN), allowedUserIds: ["111"] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const privateMessage = (updateId: number, from = 111, text = `message ${updateId}`) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_800_000_000,
    text,
    chat: { id: from, type: "private" },
    from: { id: from, first_name: "Ana" },
  },
});

const harness = () => {
  const backlog: unknown[] = [];
  const state = {
    failure: undefined as Response | undefined,
    ingestFails: false,
    calls: [] as Array<{ method: string; body: Record<string, unknown> }>,
  };
  const ingested: ChannelInboundMessage[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    state.calls.push({ method, body });
    if (state.failure !== undefined) return state.failure.clone();
    if (method === "getMe") return json({ ok: true, result: { username: "my_bot" } });
    if (method === "sendMessage") return json({ ok: true, result: { message_id: 9 } });
    const offset = Number(body.offset);
    const pending = backlog.filter(
      (item) => (item as { update_id: number }).update_id >= (offset < 0 ? 0 : offset),
    );
    return json({ ok: true, result: offset < 0 ? pending.slice(-1) : pending });
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
  const layer = Layer.mergeAll(gateway, ChannelTransport.layer, FetchHttpClient.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  return { backlog, state, ingested, layer, withFetch, fetch };
};

const offsetRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly id: string;
    readonly update_offset: number;
  }>`SELECT id, update_offset FROM telegram_cursor`;
  return row === undefined ? undefined : [row.id, row.update_offset];
});

it.effect(
  "starts from now, then hears only allowed people and moves its offset past every update",
  () => {
    const { backlog, ingested, layer, withFetch } = harness();
    return withFetch(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make({ autoPoll: false });
        assert.deepStrictEqual(yield* runtime.status, { status: "disabled" });
        assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);

        backlog.push(privateMessage(5), privateMessage(6));
        yield* runtime.apply(config);
        yield* runtime.pollOnce;
        assert.lengthOf(ingested, 0);
        assert.deepStrictEqual(yield* offsetRow, ["123456", 7]);
        assert.deepStrictEqual(yield* runtime.status, { status: "running", botUsername: "my_bot" });

        backlog.push(
          privateMessage(7),
          privateMessage(8, 999),
          { update_id: 9, edited_message: {} },
          privateMessage(10, 111, "/start"),
        );
        yield* runtime.pollOnce;
        assert.deepStrictEqual(
          ingested.map((message) => [
            message.idempotencyKey,
            message.conversationKey,
            message.text,
          ]),
          [
            ["telegram:7", "111", "message 7"],
            ["telegram:10", "111", "@"],
          ],
        );
        assert.deepStrictEqual(yield* offsetRow, ["123456", 11]);

        // Nothing new: the offset stays and nothing is read twice.
        yield* runtime.pollOnce;
        assert.lengthOf(ingested, 2);
        yield* runtime.apply(null);
        assert.deepStrictEqual(yield* runtime.status, { status: "disabled" });
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect("keeps an update the gateway could not store, and tries it again after a pause", () => {
  const { backlog, state, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* Runtime.make({ autoPoll: false });
      yield* runtime.apply(config);
      yield* runtime.pollOnce;
      backlog.push(privateMessage(1), privateMessage(2));
      state.ingestFails = true;
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.seconds(5));
      assert.deepStrictEqual(yield* offsetRow, ["123456", 0]);
      state.ingestFails = false;
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
      assert.deepStrictEqual(
        ingested.map((message) => message.idempotencyKey),
        ["telegram:1", "telegram:2"],
      );
      assert.deepStrictEqual(yield* offsetRow, ["123456", 3]);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("shows why it stopped, backs off instead of looping, and recovers on its own", () => {
  const { state, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* Runtime.make({ autoPoll: false });
      yield* runtime.apply(config);
      state.failure = json({ ok: false, error_code: 401 }, 401);
      const delays: number[] = [];
      for (let i = 0; i < 9; i += 1) {
        delays.push(Duration.toSeconds(yield* runtime.pollOnce));
      }
      assert.deepStrictEqual(delays, [2, 4, 8, 16, 32, 64, 128, 256, 300]);
      assert.deepStrictEqual(yield* runtime.status, {
        status: "error",
        lastError: "invalid_token",
      });

      state.failure = json({ ok: false, error_code: 409 }, 409);
      assert.deepStrictEqual(Duration.toSeconds(yield* runtime.pollOnce), 60);
      assert.strictEqual((yield* runtime.status).lastError, "conflict");

      state.failure = json({ ok: false, error_code: 429, parameters: { retry_after: 90 } }, 429);
      assert.deepStrictEqual(Duration.toSeconds(yield* runtime.pollOnce), 90);
      assert.strictEqual((yield* runtime.status).lastError, "rate_limited");

      state.failure = new Response("<html>", { status: 502 });
      yield* runtime.pollOnce;
      assert.strictEqual((yield* runtime.status).lastError, "unreachable");

      state.failure = undefined;
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
      assert.strictEqual((yield* runtime.status).status, "running");
      // A new failure starts over from the shortest wait.
      state.failure = json({ ok: false, error_code: 401 }, 401);
      assert.deepStrictEqual(Duration.toSeconds(yield* runtime.pollOnce), 2);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect(
  "sends replies through the bot while on, and shows a failed send until one succeeds",
  () => {
    const { state, layer, withFetch } = harness();
    return withFetch(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make({ autoPoll: false });
        const registry = yield* ChannelTransport.ChannelTransportRegistry;
        const transport = Option.getOrThrow(yield* registry.resolve("telegram"));
        const outbound = {
          deliveryId: "d1",
          destination: { kind: "telegram", connectionId: "telegram", chatId: "111" },
          text: "hi",
          senderName: "Jarvis",
        } as const;
        const off = yield* Effect.flip(transport.send(outbound));
        assert.strictEqual(off.reason, "adapter_unavailable");

        yield* runtime.apply(config);
        state.failure = json({ ok: false, error_code: 401 }, 401);
        const refused = yield* Effect.flip(transport.send(outbound));
        assert.strictEqual(refused.deliveryOutcome, "not_sent");
        const status = yield* runtime.status;
        assert.strictEqual(status.lastError, "invalid_token");
        assert.strictEqual(status.lastDeliveryError?.code, "unknown");

        state.failure = undefined;
        const receipt = yield* transport.send(outbound);
        assert.strictEqual(receipt.externalMessageId, "9");
        assert.deepStrictEqual(yield* runtime.status, { status: "running" });
        const sendCall = state.calls.findLast((call) => call.method === "sendMessage");
        assert.deepStrictEqual(sendCall?.body.chat_id, "111");
        assert.strictEqual(sendCall?.body.text, "Jarvis: hi");
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect("stops the request in flight the moment it is turned off", () => {
  const { layer, fetch: base } = harness();
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let aborted: () => void = () => {};
  const abortedSignal = new Promise<void>((resolve) => (aborted = resolve));
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { timeout?: number };
    if (String(url).endsWith("getUpdates") && body.timeout === 25) {
      release();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => {
          aborted();
          reject(new Error("aborted"));
        }),
      );
    }
    return base(url, init);
  };
  return Effect.gen(function* () {
    const runtime = yield* Runtime.make();
    yield* runtime.apply(config);
    yield* Effect.promise(() => blocked);
    assert.strictEqual((yield* runtime.status).status, "running");
    yield* runtime.apply(null);
    yield* Effect.promise(() => abortedSignal);
    assert.deepStrictEqual(yield* runtime.status, { status: "disabled" });
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.provide(layer));
});
