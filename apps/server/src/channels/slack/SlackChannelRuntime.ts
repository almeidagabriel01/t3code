/**
 * Keeps the configured Slack connection alive: one supervisor fiber authenticates, opens a
 * Socket Mode session per attempt and reconnects with backoff. Revocation and a workspace
 * mismatch stop it until the connection is applied again.
 */
import type { ChannelDeliveryErrorCode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import {
  handleSlackEnvelope,
  makeSlackChannelTransport,
  type SlackActiveSession,
  type SlackDeliveryFailureReport,
} from "./SlackChannelAdapter.ts";
import type { SlackRevocationEvent } from "./slackEventMapping.ts";
import * as SlackSdk from "./SlackSdk.ts";

/** What a settings service hands the runtime. Tokens never leave it. */
export interface SlackConnectionConfig {
  readonly connectionId: string;
  readonly appToken: string;
  readonly botToken: string;
  readonly allowedChannelIds: ReadonlyArray<string>;
  /** The workspace the tokens were validated against; the connection stops on any other. */
  readonly expectedTeamId?: string | undefined;
}

export type SlackConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface SlackRuntimeStatus {
  readonly status: SlackConnectionStatus;
  readonly connectionId?: string;
  /** A fixed reason such as `token_revoked`; never a raw Slack message. */
  readonly lastError?: string;
  readonly lastDeliveryError?: {
    readonly code: ChannelDeliveryErrorCode;
    readonly at: string;
    readonly channelId: string;
  };
  readonly teamId?: string;
  readonly botUserId?: string;
}

const DISABLED: SlackRuntimeStatus = { status: "disabled" };
const START_TIMEOUT = Duration.seconds(30);
const DISCONNECT_TIMEOUT = Duration.seconds(5);
const MAX_BACKOFF_SECONDS = 60;

export class SlackChannelRuntime extends Context.Service<
  SlackChannelRuntime,
  {
    /** Replaces the running session with one for this configuration; `null` stops it. */
    readonly apply: (config: SlackConnectionConfig | null) => Effect.Effect<void>;
    readonly status: Effect.Effect<SlackRuntimeStatus>;
    /** The current status first, then each change. */
    readonly streamStatus: Stream.Stream<SlackRuntimeStatus>;
  }
>()("t3/channels/slack/SlackChannelRuntime") {}

/** How one attempt ended without failing. */
type AttemptEnd =
  | { readonly _tag: "disconnected"; readonly connected: boolean }
  | { readonly _tag: "stopped"; readonly lastError: string };

const sameStatus = (a: SlackRuntimeStatus, b: SlackRuntimeStatus) =>
  a.status === b.status &&
  a.lastError === b.lastError &&
  a.teamId === b.teamId &&
  a.botUserId === b.botUserId &&
  a.lastDeliveryError?.code === b.lastDeliveryError?.code &&
  a.lastDeliveryError?.at === b.lastDeliveryError?.at &&
  a.lastDeliveryError?.channelId === b.lastDeliveryError?.channelId;

const backoffSeconds = (failures: number) =>
  Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.max(0, failures - 1));

const make = Effect.gen(function* () {
  const sdk = yield* SlackSdk.SlackSdk;
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const gatewayContext = yield* Effect.context<ChannelGateway.ChannelGateway>();
  const layerScope = yield* Effect.scope;

  const applyLock = yield* Semaphore.make(1);
  const generations = yield* Ref.make(0);
  /** The generation allowed to act; `undefined` once the connection was stopped or replaced. */
  const currentGeneration = yield* Ref.make<number | undefined>(undefined);
  const supervisor = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
  const activeSession = yield* Ref.make<SlackActiveSession | undefined>(undefined);
  const stopSignal = yield* Ref.make<
    { readonly generation: number; readonly end: Deferred.Deferred<AttemptEnd> } | undefined
  >(undefined);
  const statusRef = yield* SubscriptionRef.make<SlackRuntimeStatus>(DISABLED);

  const updateStatus = (update: (previous: SlackRuntimeStatus) => SlackRuntimeStatus) =>
    SubscriptionRef.update(statusRef, update);

  /** Keeps the delivery error and workspace across transitions within one configuration. */
  const setPhase = (status: SlackConnectionStatus, lastError?: string) =>
    updateStatus((previous) => ({
      status,
      ...(previous.connectionId === undefined ? {} : { connectionId: previous.connectionId }),
      ...(lastError === undefined ? {} : { lastError }),
      ...(previous.lastDeliveryError === undefined
        ? {}
        : { lastDeliveryError: previous.lastDeliveryError }),
      ...(previous.teamId === undefined ? {} : { teamId: previous.teamId }),
      ...(previous.botUserId === undefined ? {} : { botUserId: previous.botUserId }),
    }));

  const dropDelivery = (generation: number) =>
    Ref.update(activeSession, (session) =>
      session?.generation === generation ? undefined : session,
    );

  const forgetSession = (generation: number) =>
    Effect.all([
      dropDelivery(generation),
      Ref.update(stopSignal, (signal) => (signal?.generation === generation ? undefined : signal)),
    ]);

  const isCurrent = (generation: number) =>
    Effect.map(Ref.get(currentGeneration), (current) => current === generation);

  const attempt = Effect.fn("t3/channels/slack/SlackChannelRuntime.attempt")(function* (
    connection: SlackConnectionConfig,
    generation: number,
  ) {
    const botApi = sdk.botApi({ botToken: connection.botToken });
    const identity = yield* SlackSdk.slackCall("auth.test", botApi.authTest);
    if (connection.expectedTeamId !== undefined && identity.teamId !== connection.expectedTeamId) {
      return { _tag: "stopped", lastError: "workspace_mismatch" } satisfies AttemptEnd;
    }
    yield* updateStatus((previous) => ({
      ...previous,
      teamId: identity.teamId,
      botUserId: identity.botUserId,
    }));

    const end = yield* Deferred.make<AttemptEnd>();
    const connected = yield* Ref.make(false);
    yield* Ref.set(stopSignal, { generation, end });
    const envelopeLock = yield* Semaphore.make(1);
    const revokedReason = yield* Ref.make<string | undefined>(undefined);
    const onRevocation = Effect.fn("t3/channels/slack/SlackChannelRuntime.onRevocation")(function* (
      event: SlackRevocationEvent,
    ) {
      // A replaced session leaves the event unacknowledged so Slack redelivers it to the new one.
      if (!(yield* isCurrent(generation))) return false;
      const reason = event.kind === "app_uninstalled" ? "app_uninstalled" : "token_revoked";
      yield* Ref.set(revokedReason, reason);
      yield* dropDelivery(generation);
      yield* setPhase("error", reason);
      return true;
    });

    // Event handlers live in this attempt's scope and stop with it.
    const runFork = yield* FiberSet.makeRuntime();
    const classifier = {
      teamId: identity.teamId,
      botUserId: identity.botUserId,
      allowedChannelIds: new Set(connection.allowedChannelIds),
    };
    const handleEnvelope = (envelope: SlackSdk.SlackSocketEnvelope) =>
      envelopeLock.withPermits(1)(
        handleSlackEnvelope(envelope, {
          connectionId: connection.connectionId,
          classifier,
          onRevocation,
        }).pipe(
          Effect.flatMap((outcome) =>
            Effect.gen(function* () {
              if (outcome.handling === "team_mismatch") {
                yield* dropDelivery(generation);
                yield* setPhase("error", "workspace_mismatch");
                yield* Deferred.succeed(end, {
                  _tag: "stopped",
                  lastError: "workspace_mismatch",
                });
              } else if (outcome.handling === "revocation") {
                const lastError = yield* Ref.get(revokedReason);
                if (lastError !== undefined) {
                  yield* Deferred.succeed(end, { _tag: "stopped", lastError });
                }
              }
            }),
          ),
        ),
      );

    const session = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const opened = sdk.openSession(connection.appToken);
        const removeEnvelopeListener = opened.onEnvelope((envelope) => {
          runFork(Effect.provide(handleEnvelope(envelope), gatewayContext));
        });
        const removeLifecycleListener = opened.onLifecycle((event) => {
          if (event._tag === "disconnected") {
            runFork(
              Effect.flatMap(Ref.get(connected), (wasConnected) =>
                Deferred.succeed(end, { _tag: "disconnected", connected: wasConnected }),
              ),
            );
          }
        });
        return { opened, removeEnvelopeListener, removeLifecycleListener };
      }),
      ({ opened, removeEnvelopeListener, removeLifecycleListener }) =>
        Effect.sync(() => {
          removeEnvelopeListener();
          removeLifecycleListener();
        }).pipe(
          // Bounded: never wait on start(), which may be waiting for a hello that never comes.
          Effect.andThen(
            Effect.promise(() => opened.disconnect().catch(() => undefined)).pipe(
              Effect.timeout(DISCONNECT_TIMEOUT),
              Effect.ignore,
            ),
          ),
        ),
    );

    yield* SlackSdk.slackCall("socket.start", session.opened.start).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new SlackSdk.SlackSdkFailure({ operation: "socket.start", category: "network" }),
          ),
      }),
    );
    yield* Ref.set(connected, true);
    if ((yield* Ref.get(revokedReason)) === undefined) {
      yield* Ref.set(activeSession, {
        generation,
        connectionId: connection.connectionId,
        teamId: identity.teamId,
        botUserId: identity.botUserId,
        botApi,
      });
      yield* setPhase("connected");
    }
    return yield* Deferred.await(end);
  }, Effect.scoped);

  const supervise = Effect.fn("t3/channels/slack/SlackChannelRuntime.supervise")(
    function* (connection: SlackConnectionConfig, generation: number) {
      let failures = 0;
      while (true) {
        const exit = yield* Effect.exit(attempt(connection, generation));
        yield* forgetSession(generation);
        let waitSeconds: number;
        if (Exit.isSuccess(exit)) {
          const end = exit.value;
          if (end._tag === "stopped") {
            yield* setPhase("error", end.lastError);
            return;
          }
          failures = end.connected ? 1 : failures + 1;
          waitSeconds = backoffSeconds(failures);
        } else {
          // A defect in an attempt is unexpected; retry it like an unknown failure.
          const failure = Exit.findErrorOption(exit);
          const category = Option.isSome(failure) ? failure.value.category : "unknown";
          if (category === "auth_revoked" || category === "auth_invalid") {
            yield* setPhase(
              "error",
              category === "auth_revoked" ? "token_revoked" : "invalid_token",
            );
            return;
          }
          failures += 1;
          const retryAfterSeconds = Option.isSome(failure)
            ? failure.value.retryAfterSeconds
            : undefined;
          waitSeconds =
            category === "rate_limited"
              ? Math.max(1, retryAfterSeconds ?? 1)
              : backoffSeconds(failures);
          yield* Effect.logWarning("Slack connection attempt failed.").pipe(
            Effect.annotateLogs({ category }),
          );
        }
        yield* setPhase("reconnecting");
        yield* Effect.sleep(Duration.seconds(waitSeconds));
      }
    },
    (effect, connection, generation) =>
      effect.pipe(
        Effect.ensuring(forgetSession(generation)),
        Effect.annotateLogs({ connectionId: connection.connectionId }),
      ),
  );

  /** Stops the running supervisor and waits for its socket to be released. */
  const retire = Effect.gen(function* () {
    yield* Ref.set(currentGeneration, undefined);
    const fiber = yield* Ref.getAndSet(supervisor, undefined);
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
  });

  const apply = Effect.fn("t3/channels/slack/SlackChannelRuntime.apply")(function* (
    config: SlackConnectionConfig | null,
  ) {
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        yield* retire;
        yield* Ref.set(activeSession, undefined);
        if (config === null) {
          yield* SubscriptionRef.set(statusRef, DISABLED);
          return;
        }
        const missingToken = config.appToken === "" || config.botToken === "";
        // Another connection's history is not this one's; the same one keeps what it learned.
        yield* updateStatus(({ lastError: _, status: __, ...previous }) => ({
          ...(previous.connectionId === config.connectionId ? previous : {}),
          status: missingToken ? "error" : "connecting",
          connectionId: config.connectionId,
          ...(missingToken ? { lastError: "missing_token" } : {}),
        }));
        if (missingToken) return;
        const generation = yield* Ref.updateAndGet(generations, (value) => value + 1);
        yield* Ref.set(currentGeneration, generation);
        const fiber = yield* Effect.forkIn(supervise(config, generation), layerScope);
        yield* Ref.set(supervisor, fiber);
      }),
    );
  });

  const reportFailure = Effect.fn("t3/channels/slack/SlackChannelRuntime.reportFailure")(
    function* (connectionId: string, generation: number, report: SlackDeliveryFailureReport) {
      const signal = yield* Ref.get(stopSignal);
      if (signal === undefined || signal.generation !== generation) return;
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* updateStatus((previous) => ({
        ...previous,
        lastDeliveryError: { code: report.code, at, channelId: report.channelId },
      }));
      if (report.code === "token_revoked" || report.code === "invalid_auth") {
        const lastError = report.code === "token_revoked" ? "token_revoked" : "invalid_token";
        yield* dropDelivery(generation);
        yield* setPhase("error", lastError);
        yield* Deferred.succeed(signal.end, { _tag: "stopped", lastError });
      }
    },
    (effect, connectionId) => effect.pipe(Effect.annotateLogs({ connectionId })),
  );

  // Registered for the layer's lifetime: with no session the transport answers with the
  // connection's state, so a delivery learns why it failed instead of finding no transport.
  yield* registry.register(
    makeSlackChannelTransport({
      activeSession: (connectionId) =>
        Effect.map(Ref.get(activeSession), (session) =>
          Option.fromNullishOr(session?.connectionId === connectionId ? session : undefined),
        ),
      reportFailure,
      status: (connectionId) =>
        Effect.map(SubscriptionRef.get(statusRef), (status) =>
          status.connectionId === connectionId ? status : DISABLED,
        ),
    }),
  );

  return SlackChannelRuntime.of({
    apply,
    status: SubscriptionRef.get(statusRef),
    streamStatus: SubscriptionRef.changes(statusRef).pipe(Stream.changesWith(sameStatus)),
  });
});

export const layer = Layer.effect(SlackChannelRuntime, make);
