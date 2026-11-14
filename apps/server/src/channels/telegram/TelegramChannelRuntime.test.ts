import { assert, it } from "@effect/vitest";
import { ChannelGatewayError, type ChannelInboundMessage } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AssistantService from "../../assistants/AssistantService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { ChannelGateway } from "../ChannelGateway.ts";
import { ChannelLanguage } from "../ChannelLanguage.ts";
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
    from: { id: from, first_name: "Ana", ...(from === 111 ? {} : { username: "stranger" }) },
  },
});

const harness = (language: "en" | "pt-BR" = "en") => {
  const backlog: unknown[] = [];
  const state = {
    failure: undefined as Response | undefined,
    ingestFails: false,
    commandsFail: false,
    calls: [] as Array<{ method: string; body: Record<string, unknown> }>,
  };
  const ingested: ChannelInboundMessage[] = [];
  const assistants: Array<{ handle: string; name: string; archivedAt: string | null }> = [
    { handle: "jarvis", name: "Jarvis", archivedAt: null },
    { handle: "old-one", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const queues: { events?: Queue.Queue<{ type: "snapshot" }> } = {};
  const assistantEvents = Effect.suspend(() => Queue.offer(queues.events!, { type: "snapshot" }));
  let commandWaiter: { count: number; resolve: () => void } | undefined;
  const commandsSet = () => state.calls.filter((call) => call.method === "setMyCommands");
  const whenCommandsSet = (count: number) =>
    new Promise<void>((resolve) => {
      if (commandsSet().length >= count) return resolve();
      commandWaiter = { count, resolve };
    });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").at(-1) ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    state.calls.push({ method, body });
    if (
      method === "setMyCommands" &&
      commandWaiter &&
      commandsSet().length >= commandWaiter.count
    ) {
      commandWaiter.resolve();
    }
    if (state.failure !== undefined) return state.failure.clone();
    if (method === "setMyCommands") {
      return state.commandsFail
        ? json({ ok: false, error_code: 400 }, 400)
        : json({ ok: true, result: true });
    }
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
  const assistantService = Layer.effect(
    AssistantService.AssistantService,
    Effect.gen(function* () {
      queues.events = yield* Queue.unbounded<{ type: "snapshot" }>();
      return AssistantService.AssistantService.of({
        list: Effect.succeed(assistants),
        subscribe: Stream.fromQueue(queues.events),
      } as never);
    }),
  );
  const layer = Layer.mergeAll(
    gateway,
    assistantService,
    ChannelTransport.layer,
    ChannelLanguage.layerFixed(language),
    FetchHttpClient.layer,
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  return {
    backlog,
    state,
    ingested,
    layer,
    withFetch,
    fetch,
    assistants,
    assistantEvents,
    commandsSet,
    whenCommandsSet,
  };
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
        assert.strictEqual(sendCall?.body.text, "<b>Jarvis:</b> hi");
        assert.strictEqual(sendCall?.body.parse_mode, "HTML");
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

const replies = (calls: ReadonlyArray<{ method: string; body: Record<string, unknown> }>) =>
  calls.filter((call) => call.method === "sendMessage").map((call) => call.body.chat_id);

it.effect("tells an unknown sender their message waits, in the configured language", () => {
  const { backlog, state, layer, withFetch } = harness("pt-BR");
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* Runtime.make({ autoPoll: false });
      yield* runtime.apply({ ...config, allowedUserIds: [] });
      yield* runtime.pollOnce;
      backlog.push(privateMessage(1, 222));
      yield* runtime.pollOnce;
      const notice = state.calls.findLast((call) => call.method === "sendMessage");
      assert.include(String(notice?.body.text), "aguardando a aprovação do dono");
    }),
  ).pipe(Effect.provide(layer));
});

it.effect(
  "remembers unknown senders without routing them, answers each once, and drops them once allowed",
  () => {
    const { backlog, state, ingested, layer, withFetch } = harness();
    return withFetch(
      Effect.gen(function* () {
        const runtime = yield* Runtime.make({ autoPoll: false });
        yield* runtime.apply({ ...config, allowedUserIds: [] });
        yield* runtime.pollOnce;
        backlog.push(privateMessage(1, 222), privateMessage(2, 333), privateMessage(3, 222));
        yield* runtime.pollOnce;
        assert.lengthOf(ingested, 0);
        assert.deepStrictEqual(replies(state.calls), ["222", "333"]);
        const status = yield* runtime.status;
        assert.deepStrictEqual(
          status.pendingSenders?.map((sender) => [
            sender.userId,
            sender.firstName,
            sender.username,
          ]),
          [
            ["222", "Ana", "stranger"],
            ["333", "Ana", "stranger"],
          ],
        );

        // Allowing one keeps the other waiting; dismissing the other empties the list.
        yield* runtime.apply({ ...config, allowedUserIds: ["333"] });
        assert.deepStrictEqual(
          (yield* runtime.status).pendingSenders?.map((sender) => sender.userId),
          ["222"],
        );
        yield* runtime.dismiss(["222"]);
        assert.isUndefined((yield* runtime.status).pendingSenders);

        // The list keeps only the newest five.
        for (let id = 10; id < 17; id += 1) backlog.push(privateMessage(id, 500 + id));
        yield* runtime.pollOnce;
        assert.lengthOf((yield* runtime.status).pendingSenders ?? [], 5);
        assert.strictEqual((yield* runtime.status).pendingSenders?.[0]?.userId, "516");
        yield* runtime.apply(null);
        assert.deepStrictEqual(yield* runtime.status, { status: "disabled" });
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect("sets the bot's / menu after getMe and again when the assistants change", () => {
  const { layer, withFetch, assistants, assistantEvents, commandsSet, whenCommandsSet, state } =
    harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* Runtime.make({ autoPoll: false });
      yield* runtime.apply(config);
      yield* runtime.pollOnce;
      assert.deepStrictEqual(
        commandsSet().map((call) => call.body),
        [{ commands: [{ command: "jarvis", description: "Jarvis" }] }],
      );

      // Nothing changed: the menu is not sent again.
      yield* assistantEvents;
      assistants.push({ handle: "code-reviewer", name: "Code Reviewer", archivedAt: null });
      const second = whenCommandsSet(2);
      yield* assistantEvents;
      yield* Effect.promise(() => second);
      assert.deepStrictEqual(commandsSet().at(-1)?.body.commands, [
        { command: "jarvis", description: "Jarvis" },
        { command: "code_reviewer", description: "Code Reviewer" },
      ]);

      // A refused menu is logged, polling carries on, and the next change retries.
      state.commandsFail = true;
      assistants.pop();
      const third = whenCommandsSet(3);
      yield* assistantEvents;
      yield* Effect.promise(() => third);
      assert.strictEqual((yield* runtime.status).status, "running");
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
    }),
  ).pipe(Effect.provide(layer));
});
