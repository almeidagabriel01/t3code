import {
  AssistantError,
  type AssistantSandboxRemoveInput,
  type AssistantSandboxStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AssistantSandbox from "./AssistantSandbox.ts";

/** How often a client watching the status sees a container that was started or stopped outside T3. */
const WATCH_INTERVAL = "3 seconds";
const ANSWER_ATTEMPTS = 90;
/** A link this close to expiring is made again, so work never starts on a token about to die. */
const RELINK_MARGIN = { minutes: 10 } as const;
const SANDBOX_LABEL = "Assistant sandbox";

export class AssistantSandboxControl extends Context.Service<
  AssistantSandboxControl,
  {
    readonly status: Effect.Effect<AssistantSandboxStatus>;
    /** The current status, then one per change, including a container started or stopped elsewhere. */
    readonly streamStatus: Stream.Stream<AssistantSandboxStatus>;
    /**
     * Builds, starts and links the sandbox in the background and returns at once; the status shows
     * the steps. Repeating it while a start runs, or once the sandbox is ready, changes nothing.
     */
    readonly start: Effect.Effect<AssistantSandboxStatus>;
    readonly stop: Effect.Effect<AssistantSandboxStatus, AssistantError>;
    /** Removing with `deleteVolumes` also forgets the link, since its sign-in lived in those files. */
    readonly remove: (
      input: AssistantSandboxRemoveInput,
    ) => Effect.Effect<AssistantSandboxStatus, AssistantError>;
  }
>()("t3/assistants/AssistantSandboxControl") {}

interface Progress {
  readonly running: boolean;
  readonly step: string | null;
  readonly error: string | null;
}

const messageOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string" &&
  error.message !== ""
    ? error.message
    : "The sandbox could not be started.";

const sameStatus = (left: AssistantSandboxStatus, right: AssistantSandboxStatus) =>
  left.state === right.state &&
  left.step === right.step &&
  left.error === right.error &&
  left.environmentId === right.environmentId &&
  left.url === right.url &&
  left.linkedEnvironmentsEnabled === right.linkedEnvironmentsEnabled;

const make = Effect.gen(function* () {
  const sandbox = yield* AssistantSandbox.AssistantSandbox;
  const links = yield* PeerLinks.PeerLinks;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const scope = yield* Effect.scope;
  const progress = yield* SubscriptionRef.make<Progress>({
    running: false,
    step: null,
    error: null,
  });

  const recordedEnvironment = sql<{ readonly environment_id: string }>`
    SELECT environment_id FROM assistant_sandbox WHERE singleton = 1`.pipe(
    Effect.map((rows) =>
      rows[0] === undefined
        ? Option.none()
        : Option.some(EnvironmentId.make(rows[0].environment_id)),
    ),
    Effect.orElseSucceed(() => Option.none<EnvironmentId>()),
  );

  /** The recorded sandbox when this environment still holds a link to it that is not about to expire. */
  const liveLink = Effect.gen(function* () {
    const recorded = yield* recordedEnvironment;
    if (Option.isNone(recorded)) return Option.none<EnvironmentId>();
    const link = yield* links.get(recorded.value).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(link) && DateTime.isGreaterThan(link.value.expiresAt, yield* DateTime.now)
      ? recorded
      : Option.none<EnvironmentId>();
  });

  const status = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(progress);
    const container = yield* sandbox.status;
    const linked = yield* liveLink;
    const base = {
      step: current.step,
      error: current.error,
      environmentId: Option.getOrNull(linked),
      url: container.url,
      linkedEnvironmentsEnabled: yield* links.enabled,
    };
    if (current.running) return { ...base, state: "starting" } satisfies AssistantSandboxStatus;
    if (container.state === "docker_unavailable") {
      return { ...base, state: "docker_unavailable" } satisfies AssistantSandboxStatus;
    }
    if (current.error !== null)
      return { ...base, state: "failed" } satisfies AssistantSandboxStatus;
    switch (container.state) {
      case "missing":
        return { ...base, state: "not_created" } satisfies AssistantSandboxStatus;
      case "stopped":
        return { ...base, state: "stopped" } satisfies AssistantSandboxStatus;
      case "starting":
        return { ...base, state: "starting" } satisfies AssistantSandboxStatus;
      case "running":
        return Option.isSome(linked)
          ? ({ ...base, state: "running" } satisfies AssistantSandboxStatus)
          : ({
              ...base,
              state: "failed",
              error:
                "The sandbox is running but this Mac is not linked to it. Press Start to link it.",
            } satisfies AssistantSandboxStatus);
    }
  });

  const setStep = (step: string) =>
    SubscriptionRef.update(progress, (current) => ({ ...current, step }));

  const waitUntilAnswering = Effect.fn("AssistantSandboxControl.waitUntilAnswering")(function* () {
    for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt += 1) {
      const current = yield* sandbox.status;
      if (current.state === "running" && current.url !== null) return current.url;
      if (current.state !== "starting") {
        return yield* new AssistantSandbox.AssistantSandboxError({
          reason: "docker_failed",
          message: "The sandbox stopped before it answered.",
        });
      }
      yield* Effect.sleep("1 second");
    }
    return yield* new AssistantSandbox.AssistantSandboxError({
      reason: "docker_failed",
      message: "The sandbox did not answer in time.",
    });
  });

  /** Reuses a live link to the sandbox at this address; otherwise pairs with a fresh credential. */
  const linkSandbox = Effect.fn("AssistantSandboxControl.link")(function* (url: string) {
    const described = yield* links.describe(url);
    if (Option.isNone(described)) {
      return yield* new AssistantSandbox.AssistantSandboxError({
        reason: "docker_failed",
        message: "The sandbox answered, but not as a T3 Code environment.",
      });
    }
    const { environmentId } = described.value;
    const existing = yield* links.get(environmentId);
    const reusable =
      Option.isSome(existing) &&
      existing.value.urls.includes(url) &&
      DateTime.isGreaterThan(
        existing.value.expiresAt,
        DateTime.add(yield* DateTime.now, RELINK_MARGIN),
      );
    if (!reusable) {
      const credential = yield* sandbox.pairingCredential;
      yield* links.link({
        url,
        pairingCode: Redacted.value(credential),
        access: "full-access",
        expectedEnvironmentId: environmentId,
        expectedLabel: SANDBOX_LABEL,
      });
    }
    const linkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO assistant_sandbox (singleton, environment_id, linked_at)
      VALUES (1, ${environmentId}, ${linkedAt})
      ON CONFLICT (singleton) DO UPDATE SET
        environment_id = excluded.environment_id, linked_at = excluded.linked_at
    `.pipe(Effect.orDie);
  });

  const run = Effect.gen(function* () {
    if (!(yield* links.enabled)) {
      yield* setStep("Turning on Linked environments, which the sandbox link needs");
      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
    }
    yield* setStep("Starting the sandbox (the first time builds its image, which takes minutes)");
    yield* sandbox.ensure;
    yield* setStep("Waiting for the sandbox to answer");
    const url = yield* waitUntilAnswering();
    yield* setStep("Linking this Mac to the sandbox");
    yield* linkSandbox(url);
  }).pipe(
    Effect.matchCauseEffect({
      onSuccess: () => SubscriptionRef.set(progress, { running: false, step: null, error: null }),
      onFailure: (cause) =>
        Effect.logWarning("Assistant sandbox start failed", cause).pipe(
          Effect.andThen(
            SubscriptionRef.set(progress, {
              running: false,
              step: null,
              error: messageOf(Option.getOrUndefined(Cause.findErrorOption(cause))),
            }),
          ),
        ),
    }),
  );

  const start = Effect.gen(function* () {
    const alreadyRunning = yield* SubscriptionRef.modify(progress, (current) =>
      current.running
        ? ([true, current] as const)
        : ([false, { running: true, step: "Preparing the sandbox", error: null }] as const),
    );
    if (!alreadyRunning) yield* run.pipe(Effect.forkIn(scope), Effect.asVoid);
    return yield* status;
  });

  const asAssistantError = (error: AssistantSandbox.AssistantSandboxError) =>
    new AssistantError({ reason: "invalid", message: error.message });

  const stop = sandbox.stop.pipe(Effect.mapError(asAssistantError), Effect.andThen(status));

  const remove = Effect.fn("AssistantSandboxControl.remove")(function* (
    input: AssistantSandboxRemoveInput,
  ) {
    yield* sandbox.remove(input);
    if (input.deleteVolumes) {
      const recorded = yield* recordedEnvironment;
      if (Option.isSome(recorded)) {
        yield* links.unlink(recorded.value).pipe(Effect.ignore);
      }
      yield* sql`DELETE FROM assistant_sandbox WHERE singleton = 1`.pipe(Effect.orDie);
    }
    yield* SubscriptionRef.set(progress, { running: false, step: null, error: null });
    return yield* status;
  }, Effect.mapError(asAssistantError));

  const streamStatus = Stream.merge(
    SubscriptionRef.changes(progress),
    Stream.tick(WATCH_INTERVAL),
  ).pipe(
    Stream.mapEffect(() => status),
    Stream.changesWith(sameStatus),
  );

  return AssistantSandboxControl.of({ status, streamStatus, start, stop, remove });
});

export const layer = Layer.effect(AssistantSandboxControl, make);
