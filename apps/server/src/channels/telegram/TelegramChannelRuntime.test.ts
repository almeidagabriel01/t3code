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

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as AssistantService from "../../assistants/AssistantService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DecisionService from "../../decisions/DecisionService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ChannelBridge from "../ChannelBridge.ts";
import { ChannelGateway } from "../ChannelGateway.ts";
import * as ChannelOutbox from "../ChannelOutbox.ts";
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

const attachmentLayer = DocumentText.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-telegram-attachments-" })),
  Layer.provideMerge(NodeServices.layer),
);

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
  const files = new Map<string, Uint8Array>();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const fileMatch = /\/file\/bot[^/]+\/f\/(.+)$/.exec(String(url));
    if (fileMatch) {
      state.calls.push({ method: "download", body: {} });
      const bytes = files.get(fileMatch[1]!);
      return bytes === undefined
        ? new Response(`missing ${String(url)}`, { status: 404 })
        : new Response(bytes, { status: 200 });
    }
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
    if (method === "getFile") {
      return json({ ok: true, result: { file_path: `f/${String(body.file_id)}` } });
    }
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
    NodeCrypto.layer,
    attachmentLayer,
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
  const withFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  return {
    backlog,
    files,
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

const mediaMessage = (updateId: number, content: Record<string, unknown>) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_800_000_000,
    chat: { id: 111, type: "private" },
    from: { id: 111, first_name: "Ana" },
    ...content,
  },
});
const photoOf = (fileId: string) => [
  { file_id: `${fileId}-thumb`, width: 90, height: 90 },
  { file_id: fileId, width: 1280, height: 1280 },
];

/** Starts the runtime past its first-enable skip, so the next poll reads the backlog. */
const started = Effect.gen(function* () {
  const runtime = yield* Runtime.make({ autoPoll: false });
  yield* runtime.apply(config);
  yield* runtime.pollOnce;
  return runtime;
});

const storedFile = (attachmentId: string, extension: string) =>
  Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* (yield* FileSystem.FileSystem).readFile(
      path.join(attachmentsDir, `${attachmentId}${extension}`),
    );
  });

it.effect("hands on a photo, with or without a caption, saved as a pending upload", () => {
  const { backlog, files, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      files.set("big", JPEG);
      backlog.push(
        mediaMessage(1, { caption: "what is this?", photo: photoOf("big") }),
        mediaMessage(2, { photo: photoOf("big") }),
      );
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
      assert.deepStrictEqual(
        ingested.map((message) => [message.idempotencyKey, message.text]),
        [
          ["telegram:1", "what is this?"],
          ["telegram:2", ""],
        ],
      );
      const [attachment] = ingested[0]?.attachments ?? [];
      assert.deepInclude(attachment, {
        type: "image",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: JPEG.byteLength,
      });
      assert.match(attachment!.id, /^pending-/);
      assert.deepStrictEqual([...(yield* storedFile(attachment!.id, ".jpg"))], [...JPEG]);
      assert.deepStrictEqual(yield* offsetRow, ["123456", 3]);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("types an image sent as a file by its bytes, and answers one that is not", () => {
  const { backlog, files, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      files.set("png", PNG);
      files.set("fake", new TextEncoder().encode("<html>not an image</html>"));
      files.set(
        "heic",
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      );
      backlog.push(
        mediaMessage(1, {
          caption: "scan",
          document: { file_id: "png", file_name: "../../etc/scan.jpg", mime_type: "image/jpeg" },
        }),
        mediaMessage(2, {
          document: { file_id: "fake", file_name: "x.png", mime_type: "image/png" },
        }),
        mediaMessage(3, {
          document: { file_id: "heic", file_name: "x.heic", mime_type: "image/heic" },
        }),
        mediaMessage(4, { sticker: { file_id: "s" } }),
        mediaMessage(5, { voice: { file_id: "v" } }),
      );
      yield* runtime.pollOnce;
      const [scan, ...rest] = ingested;
      const [attachment] = scan?.attachments ?? [];
      assert.deepInclude(attachment, { mimeType: "image/png", name: "scan.jpg" });
      assert.deepStrictEqual([...(yield* storedFile(attachment!.id, ".png"))], [...PNG]);
      assert.deepStrictEqual(
        rest.map((message) => [message.attachmentProblem, message.attachments ?? []]),
        [
          ["unsupported", []],
          ["unsupported", []],
          ["unsupported", []],
          ["unsupported", []],
        ],
      );
      // Nothing left to redeliver.
      assert.deepStrictEqual(yield* offsetRow, ["123456", 6]);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("never downloads a file larger than an image attachment may be", () => {
  const { backlog, state, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      backlog.push(
        mediaMessage(1, {
          document: { file_id: "huge", file_name: "x.png", file_size: 10 * 1024 * 1024 + 1 },
        }),
      );
      yield* runtime.pollOnce;
      assert.strictEqual(ingested[0]?.attachmentProblem, "unsupported");
      assert.isFalse(state.calls.some((call) => call.method === "getFile"));
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("answers a failed download and keeps the token out of every log", () => {
  const { backlog, ingested, layer, withFetch } = harness();
  const logs: string[] = [];
  const logger = Logger.make((options) => {
    logs.push(JSON.stringify(options.message), String(options.cause));
  });
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      backlog.push(mediaMessage(1, { caption: "see", photo: photoOf("gone") }));
      yield* runtime.pollOnce;
      assert.deepInclude(ingested[0], { text: "see", attachmentProblem: "download_failed" });
      assert.isAbove(logs.length, 0);
      assert.notInclude(logs.join("\n"), "secret");
      assert.deepStrictEqual(yield* offsetRow, ["123456", 2]);
    }),
  ).pipe(Effect.provide(Layer.merge(layer, Logger.layer([logger], { mergeWithExisting: false }))));
});

it.effect("waits for the rest of an album, then hands it on as one message", () => {
  const { backlog, files, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      files.set("a", JPEG);
      files.set("b", PNG);
      files.set("c", JPEG);
      backlog.push(
        privateMessage(1),
        mediaMessage(2, { media_group_id: "g", photo: photoOf("a") }),
        mediaMessage(3, { media_group_id: "g", caption: "trip", photo: photoOf("b") }),
      );
      // The batch ends inside an album: what came before goes on, the album waits.
      assert.deepStrictEqual(yield* runtime.pollOnce, Runtime.ALBUM_WAIT);
      assert.deepStrictEqual(
        ingested.map((message) => message.idempotencyKey),
        ["telegram:1"],
      );
      assert.deepStrictEqual(yield* offsetRow, ["123456", 2]);
      backlog.push(mediaMessage(4, { media_group_id: "g", photo: photoOf("c") }));
      assert.deepStrictEqual(yield* runtime.pollOnce, Runtime.ALBUM_WAIT);
      assert.lengthOf(ingested, 1);
      // Nothing new arrived: the album is complete.
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
      const album = ingested[1];
      assert.deepInclude(album, { idempotencyKey: "telegram:2", text: "trip" });
      assert.deepStrictEqual(
        album?.attachments?.map((attachment) => attachment.mimeType),
        ["image/jpeg", "image/png", "image/jpeg"],
      );
      assert.deepStrictEqual(yield* offsetRow, ["123456", 5]);
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("an album the batch already closed goes on at once", () => {
  const { backlog, files, ingested, layer, withFetch } = harness();
  return withFetch(
    Effect.gen(function* () {
      const runtime = yield* started;
      files.set("a", JPEG);
      backlog.push(
        mediaMessage(1, { media_group_id: "g", photo: photoOf("a") }),
        mediaMessage(2, { media_group_id: "g", sticker: { file_id: "s" } }),
        privateMessage(3),
      );
      assert.deepStrictEqual(yield* runtime.pollOnce, Duration.zero);
      // One answer per album: the image goes on, the part it could not read is named once.
      assert.deepStrictEqual(
        ingested.map((message) => [
          message.idempotencyKey,
          message.attachments?.length ?? 0,
          message.attachmentProblem,
        ]),
        [
          ["telegram:1", 1, "unsupported"],
          ["telegram:3", 0, undefined],
        ],
      );
    }),
  ).pipe(Effect.provide(layer));
});

it.effect("a photo from Telegram reaches the assistant's thread with the image saved there", () => {
  const { backlog, files, fetch } = harness();
  const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const jarvis = {
    id: "jarvis",
    name: "Jarvis",
    handle: "jarvis",
    projectId: "scratch",
    isDefault: true,
    threadId: "assistant:jarvis:1",
    archivedAt: null,
  };
  const layer = ChannelBridge.layer.pipe(
    Layer.provideMerge(ChannelOutbox.layer),
    Layer.provideMerge(DecisionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ChannelTransport.layer,
        ChannelLanguage.layerFixed("en"),
        FetchHttpClient.layer,
        NodeCrypto.layer,
        attachmentLayer,
        Layer.mock(AssistantService.AssistantService)({
          list: Effect.succeed([jarvis]) as never,
          subscribe: Stream.never,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) => {
            sends.push(input);
            return Effect.succeed({ message: { attachments: input.attachments } } as never);
          },
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return Effect.gen(function* () {
    const runtime = yield* started;
    files.set("p", JPEG);
    backlog.push(mediaMessage(1, { caption: "@jarvis look", photo: photoOf("p") }));
    yield* runtime.pollOnce;
    const [sent] = sends;
    assert.deepStrictEqual([sent?.threadId, sent?.text], ["assistant:jarvis:1", "look"]);
    const [attachment] = sent?.attachments ?? [];
    // Claimed for the thread: the id names the thread, and the bytes are there.
    assert.match(attachment!.id, /^assistant-jarvis-1-/);
    assert.deepStrictEqual([...(yield* storedFile(attachment!.id, ".jpg"))], [...JPEG]);
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.provide(layer));
});
