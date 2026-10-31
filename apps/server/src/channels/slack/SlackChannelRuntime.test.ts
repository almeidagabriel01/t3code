import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import {
  channelMention,
  eventCallback,
  makeFakeGateway,
  makeFakeTransportRegistry,
} from "./slackChannelTestSupport.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

const APP_TOKEN = "xapp-1-SENTINEL-app";
const BOT_TOKEN = "xoxb-SENTINEL-bot";
const connectionId = "slack-conn-1";

const connection = (
  overrides: Partial<SlackChannelRuntime.SlackConnectionConfig> = {},
): SlackChannelRuntime.SlackConnectionConfig => ({
  connectionId,
  allowedChannelIds: ["C0000000001"],
  appToken: APP_TOKEN,
  botToken: BOT_TOKEN,
  expectedTeamId: "T0000000001",
  ...overrides,
});

const harness = () => {
  const sdk = makeFakeSlackSdk();
  const gateway = makeFakeGateway();
  const registry = makeFakeTransportRegistry();
  const logs: string[] = [];
  const layer = SlackChannelRuntime.layer.pipe(
    Layer.provide(Layer.mergeAll(sdk.layer, gateway.layer, registry.layer)),
  );
  const logger = Logger.layer([
    Logger.make(({ message, cause }) => {
      logs.push(`${JSON.stringify(message)} ${Cause.pretty(cause)}`);
    }),
  ]);
  return { sdk, gateway, registry, logs, layer, logger };
};

/** Waits until the connection reaches `status` (and `lastError`, when given). */
const awaitStatus = (status: SlackChannelRuntime.SlackConnectionStatus, lastError?: string) =>
  Effect.flatMap(SlackChannelRuntime.SlackChannelRuntime, (runtime) =>
    runtime.streamStatus.pipe(
      Stream.filter(
        (event) =>
          event.status === status && (lastError === undefined || event.lastError === lastError),
      ),
      Stream.runHead,
      Effect.asVoid,
    ),
  );

const statusOf = Effect.flatMap(
  SlackChannelRuntime.SlackChannelRuntime,
  (runtime) => runtime.status,
);

const send = (registry: ReturnType<typeof makeFakeTransportRegistry>) => {
  const transport = registry.registered.get("slack");
  assert(transport !== undefined);
  return transport.send({
    deliveryId: "delivery-1",
    destination: {
      kind: "slack",
      connectionId,
      teamId: "T0000000001",
      channelId: "C0000000001",
      rootTs: "1760000000.000100",
    },
    text: "done",
  });
};

const latestSession = (sdk: FakeSlackSdk) => {
  const session = sdk.sessions.at(-1);
  assert(session !== undefined);
  return session;
};

const run = <A, E>(
  h: ReturnType<typeof harness>,
  effect: Effect.Effect<A, E, SlackChannelRuntime.SlackChannelRuntime>,
) => effect.pipe(Effect.provide(Layer.merge(h.layer, h.logger)));

const apply = (input: SlackChannelRuntime.SlackConnectionConfig | null) =>
  Effect.flatMap(SlackChannelRuntime.SlackChannelRuntime, (runtime) => runtime.apply(input));

describe("SlackChannelRuntime", () => {
  it.effect("connects, hands events to the gateway, and acknowledges them", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        assert.deepEqual(h.sdk.calls, ["authTest", "open:0", "start:0"]);
        assert.equal(latestSession(h.sdk).appToken, APP_TOKEN);
        const envelope = latestSession(h.sdk).emitEnvelope(eventCallback(channelMention()));
        yield* Effect.promise(() => envelope.acked);
        const call = h.gateway.calls[0];
        assert(call?.method === "ingest");
        assert.equal(call.input.conversationKey, "T0000000001:C0000000001");
      }),
    );
  });

  it.effect("does not start without both tokens, or once stopped", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        // apply settles these statuses before it returns.
        yield* apply(connection({ botToken: "" }));
        assert.deepEqual(yield* statusOf, {
          status: "error",
          connectionId,
          lastError: "missing_token",
        });
        yield* apply(connection({ appToken: "" }));
        assert.equal((yield* statusOf).lastError, "missing_token");
        yield* apply(null);
        assert.deepEqual(yield* statusOf, { status: "disabled" });
        assert.deepEqual(h.sdk.calls, []);
      }),
    );
  });

  it.effect("reconnects after a drop, releasing the old socket before opening a new one", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        latestSession(h.sdk).emitLifecycle("disconnected");
        yield* awaitStatus("reconnecting");
        assert.deepEqual(h.sdk.calls.slice(3), ["disconnect:0"]);
        assert.equal(h.sdk.sessions[0]?.listenerCount(), 0);
        yield* TestClock.adjust("1 second");
        yield* awaitStatus("connected");
        assert.deepEqual(h.sdk.calls.slice(3), ["disconnect:0", "authTest", "open:1", "start:1"]);
      }),
    );
  });

  it.effect("retries when the first start fails before any socket event", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        let starts = 0;
        h.sdk.script.start = () => {
          starts += 1;
          return starts === 1
            ? Promise.reject(h.sdk.failure("socket.start", "network"))
            : Promise.resolve();
        };
        yield* apply(connection());
        yield* awaitStatus("reconnecting");
        yield* TestClock.adjust("1 second");
        yield* awaitStatus("connected");
        assert.equal(starts, 2);
      }),
    );
  });

  it.effect("waits out Slack's Retry-After before trying again", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        let attempts = 0;
        h.sdk.script.authTest = () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(h.sdk.failure("auth.test", "rate_limited", 5))
            : Promise.resolve({
                teamId: "T0000000001",
                botUserId: "U0000000002",
                botId: undefined,
              });
        };
        yield* apply(connection());
        yield* awaitStatus("reconnecting");
        yield* TestClock.adjust("4 seconds");
        assert.equal(attempts, 1);
        yield* TestClock.adjust("1 second");
        yield* awaitStatus("connected");
        assert.equal(attempts, 2);
      }),
    );
  });

  it.effect("stops for good on a revoked token, at start or while delivering", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        h.sdk.script.authTest = () => Promise.reject(h.sdk.failure("auth.test", "auth_revoked"));
        yield* apply(connection());
        yield* awaitStatus("error", "token_revoked");
        yield* TestClock.adjust("10 minutes");
        assert.equal(h.sdk.calls.filter((call) => call === "authTest").length, 1);

        h.sdk.script.authTest = () =>
          Promise.resolve({ teamId: "T0000000001", botUserId: "U0000000002", botId: undefined });
        h.sdk.script.postMessage = () =>
          Promise.reject(h.sdk.failure("chat.postMessage", "auth_revoked"));
        yield* apply(connection());
        yield* awaitStatus("connected");
        const index = latestSession(h.sdk).index;
        assert.equal((yield* Effect.flip(send(h.registry))).deliveryErrorCode, "token_revoked");
        yield* awaitStatus("error", "token_revoked");
        assert(h.sdk.calls.includes(`disconnect:${index}`));
        assert.equal((yield* Effect.flip(send(h.registry))).deliveryErrorCode, "token_revoked");
        yield* TestClock.adjust("10 minutes");
        assert.equal(h.sdk.sessions.length, index + 1);
      }),
    );
  });

  it.effect("shows a workspace mismatch from the bot token or from incoming events", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection({ expectedTeamId: "T0SAVED" }));
        yield* awaitStatus("error", "workspace_mismatch");
        assert.deepEqual(h.sdk.calls, ["authTest"]);

        yield* apply(connection());
        yield* awaitStatus("connected");
        const session = latestSession(h.sdk);
        const envelope = session.emitEnvelope(
          eventCallback(channelMention(), { team_id: "T0OTHER" }),
        );
        yield* Effect.promise(() => envelope.acked);
        yield* awaitStatus("error", "workspace_mismatch");
        assert(h.sdk.calls.includes(`disconnect:${session.index}`));
        assert.equal(h.gateway.calls.length, 0);
      }),
    );
  });

  it.effect("records a missing channel without dropping the connection", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        h.sdk.script.postMessage = () =>
          Promise.reject(h.sdk.failure("chat.postMessage", "not_in_channel"));
        yield* apply(connection());
        yield* awaitStatus("connected");
        yield* Effect.flip(send(h.registry));
        const status = yield* statusOf;
        assert.equal(status.status, "connected");
        assert.equal(status.lastDeliveryError?.code, "not_in_channel");
        assert.equal(status.lastDeliveryError?.channelId, "C0000000001");
      }),
    );
  });

  it.effect("stops delivering once the connection is stopped", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        yield* apply(null);
        assert.equal((yield* Effect.flip(send(h.registry))).reason, "adapter_unavailable");
        assert.equal(h.sdk.posted.length, 0);
        assert(h.sdk.calls.includes("disconnect:0"));
      }),
    );
  });

  it.effect("ignores a failure reported by a session that was already replaced", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        let rejectPost!: (error: unknown) => void;
        h.sdk.script.postMessage = () =>
          new Promise((_resolve, reject) => {
            rejectPost = reject;
          });
        yield* apply(connection());
        yield* awaitStatus("connected");
        const inFlight = yield* Effect.forkChild(Effect.flip(send(h.registry)));
        yield* Effect.promise(() => h.sdk.waitForCall("post"));
        yield* apply(connection());
        yield* awaitStatus("connected");
        rejectPost(h.sdk.failure("chat.postMessage", "auth_revoked"));
        yield* Fiber.join(inFlight);
        assert.equal((yield* statusOf).status, "connected");
      }),
    );
  });

  it.effect("replaces a session whose start never finishes, closing it first", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        h.sdk.holdStarts();
        yield* apply(connection());
        yield* Effect.promise(() => h.sdk.waitForCall("start:0"));
        assert.equal((yield* statusOf).status, "connecting");
        yield* apply(connection());
        yield* Effect.promise(() => h.sdk.waitForCall("start:1"));
        assert.deepEqual(h.sdk.calls, [
          "authTest",
          "open:0",
          "start:0",
          "disconnect:0",
          "authTest",
          "open:1",
          "start:1",
        ]);
      }),
    );
  });

  it.effect("closes a pending session and unregisters the transport when the layer stops", () =>
    Effect.gen(function* () {
      const h = harness();
      h.sdk.holdStarts();
      const scope = yield* Scope.make();
      const services = yield* Layer.buildWithScope(h.layer, scope);
      const runtime = services.mapUnsafe.get(SlackChannelRuntime.SlackChannelRuntime.key) as
        | SlackChannelRuntime.SlackChannelRuntime["Service"]
        | undefined;
      assert(runtime !== undefined);
      yield* runtime.apply(connection());
      yield* Effect.promise(() => h.sdk.waitForCall("start:0"));
      assert(h.registry.registered.has("slack"));
      yield* Scope.close(scope, Exit.void);
      assert(h.sdk.calls.includes("disconnect:0"));
      assert(!h.registry.registered.has("slack"));
    }),
  );

  it.effect("streams the current status first, then only later changes", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
        yield* apply(connection());
        yield* awaitStatus("connected");
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* Effect.forkChild(
          runtime.streamStatus.pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.take(2),
            Stream.runCollect,
          ),
        );
        yield* Deferred.await(subscribed);
        yield* apply(null);
        const events = Array.from(yield* Fiber.join(collected));
        assert.deepEqual(
          events.map((event) => event.status),
          ["connected", "disabled"],
        );
      }),
    );
  });

  it.effect("keeps tokens out of logs, status, and gateway input on every failure path", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const statuses: unknown[] = [];
        for (const category of ["network", "http", "unknown"] as const) {
          h.sdk.script.authTest = () => Promise.reject(h.sdk.failure("auth.test", category));
          yield* apply(connection());
          yield* awaitStatus("reconnecting");
          statuses.push(yield* statusOf);
        }
        h.sdk.script.authTest = () => Promise.reject(h.sdk.failure("auth.test", "auth_invalid"));
        yield* apply(connection());
        yield* awaitStatus("error", "invalid_token");
        statuses.push(yield* statusOf);
        h.sdk.script.authTest = () =>
          Promise.resolve({ teamId: "T0000000001", botUserId: "U0000000002", botId: undefined });
        yield* apply(connection());
        yield* awaitStatus("connected");
        const envelope = latestSession(h.sdk).emitEnvelope(eventCallback(channelMention()));
        yield* Effect.promise(() => envelope.acked);
        const evidence = JSON.stringify({ logs: h.logs, statuses, calls: h.gateway.calls });
        assert(h.logs.length > 0);
        assert(!evidence.includes("SENTINEL"));
      }),
    );
  });
});

describe("Slack delivery status", () => {
  it.effect.each([
    ["rate_limited", "rate_limited"],
    ["auth_revoked", "token_revoked"],
    ["auth_invalid", "invalid_auth"],
    ["not_in_channel", "not_in_channel"],
    ["channel_not_found", "channel_not_found"],
    ["network", "network"],
    ["timeout", "timeout"],
    ["unknown", "unknown"],
  ] as const)("publishes every failure code as lastDeliveryError: %j", ([category, code]) => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        h.sdk.script.postMessage = () =>
          Promise.reject(h.sdk.failure("chat.postMessage", category));
        const error = yield* Effect.flip(send(h.registry));
        assert.equal(error.deliveryErrorCode, code);
        const status = yield* statusOf;
        assert.equal(status.lastDeliveryError?.code, code);
        assert.equal(status.lastDeliveryError?.channelId, "C0000000001");
        assert.match(status.lastDeliveryError?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
      }),
    );
  });

  it.effect("connecting and reconnecting delivery is retryable not_sent without a code", () => {
    const h = harness();
    h.sdk.holdStarts();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* Effect.promise(() => h.sdk.waitForCall("start:0"));
        const connecting = yield* Effect.flip(send(h.registry));
        assert.equal(connecting.reason, "delivery_failed");
        assert.equal(connecting.deliveryOutcome, "not_sent");
        assert.equal(connecting.deliveryErrorCode, undefined);
        h.sdk.pendingStarts[0]!.resolve();
        yield* awaitStatus("connected");
        latestSession(h.sdk).emitLifecycle("disconnected");
        yield* awaitStatus("reconnecting");
        const reconnecting = yield* Effect.flip(send(h.registry));
        assert.equal(reconnecting.reason, "delivery_failed");
        assert.equal(reconnecting.deliveryOutcome, "not_sent");
        assert.equal(reconnecting.deliveryErrorCode, undefined);
        assert.equal(h.sdk.posted.length, 0);
      }),
    );
  });

  it.effect.each(["auth_revoked", "auth_invalid"] as const)(
    "blocks delivery and publishes error before slow teardown: %s",
    (category) => {
      const h = harness();
      return run(
        h,
        Effect.gen(function* () {
          yield* apply(connection());
          yield* awaitStatus("connected");
          const release = h.sdk.holdDisconnects();
          h.sdk.script.postMessage = () =>
            Promise.reject(h.sdk.failure("chat.postMessage", category));
          yield* Effect.flip(send(h.registry));
          yield* Effect.promise(() => h.sdk.waitForCall("disconnect:0"));
          const next = yield* Effect.flip(send(h.registry));
          assert.equal(next.reason, "delivery_failed");
          assert.equal(next.deliveryOutcome, "not_sent");
          assert.equal(
            next.deliveryErrorCode,
            category === "auth_invalid" ? "invalid_auth" : "token_revoked",
          );
          assert.equal((yield* statusOf).status, "error");
          assert.equal(h.sdk.posted.length, 1);
          release();
        }),
      );
    },
  );

  it.effect("suppresses identical public status events for a connection", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
        yield* apply(null);
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* Effect.forkChild(
          runtime.streamStatus.pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.takeUntil((event) => event.status === "connected"),
            Stream.runCollect,
          ),
        );
        yield* Deferred.await(subscribed);
        yield* apply(null);
        yield* apply(null);
        yield* apply(connection());
        const events = yield* Fiber.join(collected);
        assert.deepEqual(
          Array.from(events, (event) => event.status),
          // The second "connecting" is the same phase gaining the workspace from auth.test.
          ["disabled", "connecting", "connecting", "connected"],
        );
      }),
    );
  });

  it.effect.each([
    ["token_revoked", { type: "tokens_revoked", tokens: { bot: ["U0000000002"] } }],
    ["app_uninstalled", { type: "app_uninstalled" }],
  ] as const)("stops for good on revocation (%s), after acknowledging it", ([reason, event]) => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        const revocation = latestSession(h.sdk).emitEnvelope(
          eventCallback(event, { event_time: 1000 }),
        );
        yield* Effect.promise(() => revocation.acked);
        yield* awaitStatus("error", reason);
        yield* Effect.promise(() => h.sdk.waitForCall("disconnect:0"));
        yield* TestClock.adjust("10 minutes");
        assert.equal(h.sdk.sessions.length, 1);
        assert.equal(revocation.ackCount(), 1);
        const error = yield* Effect.flip(send(h.registry));
        assert.equal(error.deliveryErrorCode, "token_revoked");
        assert.equal(error.deliveryOutcome, "not_sent");
        assert.equal(h.sdk.posted.length, 0);
      }),
    );
  });

  it.effect("reports the connection id and workspace once connected", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        yield* apply(connection());
        yield* awaitStatus("connected");
        assert.deepEqual(yield* statusOf, {
          status: "connected",
          connectionId,
          teamId: "T0000000001",
          botUserId: "U0000000002",
        });
      }),
    );
  });
});
