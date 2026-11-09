import {
  AssistantError,
  type AssistantSandboxPairing,
  type AssistantSandboxConfigureInput,
  type AssistantSandboxRemoveInput,
  type AssistantSandboxStatus,
  type AssistantSandboxWhenDone,
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

/**
 * How often a client watching the status sees a container that was started or stopped outside T3.
 * ponytail: every subscriber polls Docker itself; share one polling fiber if several clients watch.
 */
const WATCH_INTERVAL = "3 seconds";
const ANSWER_ATTEMPTS = 90;
/** A link this close to expiring is made again, so work never starts on a token about to die. */
const RELINK_MARGIN = { minutes: 10 } as const;
/** What a task running in the container shows as where it runs; the container reports a hostname. */
export const SANDBOX_LABEL = "Assistant sandbox";
/** How long a task waits for the sandbox to come up before it is told to ask again. */
const READY_WAIT = "90 seconds";

export interface SandboxConfig {
  /** Null: no limit. */
  readonly cpus: number | null;
  /** False until the user picked a limit, which the first task that needs the container asks for. */
  readonly chosen: boolean;
  readonly whenDone: AssistantSandboxWhenDone;
  /** The container was started only for tasks, so it may go when the last one ends. */
  readonly oneOff: boolean;
}
const DEFAULT_CONFIG: SandboxConfig = {
  cpus: null,
  chosen: false,
  whenDone: "discard",
  oneOff: false,
};

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
    readonly config: Effect.Effect<SandboxConfig>;
    /** Changes the CPU limit (also on a container that exists, at once) and what happens when a task is done. */
    readonly configure: (
      input: AssistantSandboxConfigureInput,
    ) => Effect.Effect<AssistantSandboxStatus, AssistantError>;
    /**
     * `start` for work that needs the container now: a container it had to bring up is marked as
     * started for tasks, and the call waits a while for it. Returns the status, `starting` if it
     * is still building.
     */
    readonly startForTask: Effect.Effect<AssistantSandboxStatus>;
    /** Removes the container, keeping its files and sign-ins; refused while tasks still run in it. */
    readonly discard: Effect.Effect<AssistantSandboxStatus, AssistantError>;
    /** Whether `environmentId` is the sandbox container this environment linked to. */
    readonly isSandbox: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
    /** A task started in `environmentId`; the container stays until it ends. Others are ignored. */
    readonly taskStarted: (environmentId: EnvironmentId, taskId: string) => Effect.Effect<void>;
    /** A task ended. The last one of a container started for tasks discards it, when set to. */
    readonly taskEnded: (taskId: string) => Effect.Effect<void>;
    readonly stop: Effect.Effect<AssistantSandboxStatus, AssistantError>;
    /**
     * A one-time link that connects a client on this machine to the running sandbox. Its address is
     * loopback, so only a client on this machine can use it.
     */
    readonly pairingUrl: Effect.Effect<AssistantSandboxPairing, AssistantError>;
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
  left.linkedEnvironmentsEnabled === right.linkedEnvironmentsEnabled &&
  left.cpus === right.cpus &&
  left.whenDone === right.whenDone;

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

  const readConfig = sql<{
    readonly cpus: number | null;
    readonly chosen: number;
    readonly when_done: string;
    readonly one_off: number;
  }>`SELECT cpus, chosen, when_done, one_off FROM assistant_sandbox_config WHERE singleton = 1`.pipe(
    Effect.map((rows): SandboxConfig =>
      rows[0] === undefined
        ? DEFAULT_CONFIG
        : {
            cpus: rows[0].cpus,
            chosen: rows[0].chosen === 1,
            whenDone: rows[0].when_done === "keep" ? "keep" : "discard",
            oneOff: rows[0].one_off === 1,
          },
    ),
    Effect.orElseSucceed(() => DEFAULT_CONFIG),
  );

  const writeConfig = (config: SandboxConfig) =>
    sql`
      INSERT INTO assistant_sandbox_config (singleton, cpus, chosen, when_done, one_off)
      VALUES (1, ${config.cpus}, ${config.chosen ? 1 : 0}, ${config.whenDone}, ${config.oneOff ? 1 : 0})
      ON CONFLICT (singleton) DO UPDATE SET
        cpus = excluded.cpus, chosen = excluded.chosen,
        when_done = excluded.when_done, one_off = excluded.one_off
    `.pipe(Effect.orDie, Effect.asVoid);

  const countOf = (rows: ReadonlyArray<{ readonly n: number }>) => rows[0]?.n ?? 0;
  const openTasks = sql<{
    readonly n: number;
  }>`SELECT COUNT(*) AS n FROM assistant_sandbox_task`.pipe(
    Effect.map(countOf),
    Effect.orElseSucceed(() => 0),
  );
  const sandboxAssistants = sql<{
    readonly n: number;
  }>`SELECT COUNT(*) AS n FROM assistants WHERE workspace = 'sandbox' AND archived_at IS NULL`.pipe(
    Effect.map(countOf),
    Effect.orElseSucceed(() => 0),
  );

  const recordedEnvironment = sql<{ readonly environment_id: string }>`
    SELECT environment_id FROM assistant_sandbox WHERE singleton = 1`.pipe(
    Effect.map((rows) =>
      rows[0] === undefined
        ? Option.none()
        : Option.some(EnvironmentId.make(rows[0].environment_id)),
    ),
    Effect.orElseSucceed(() => Option.none<EnvironmentId>()),
  );

  /**
   * The recorded sandbox when this environment holds an unexpired link to it at the address it
   * answers at now. Docker picks a new host port whenever the container restarts.
   */
  const liveLink = Effect.fn("AssistantSandboxControl.liveLink")(function* (
    containerUrl: string | null,
  ) {
    const recorded = yield* recordedEnvironment;
    if (Option.isNone(recorded)) return Option.none<EnvironmentId>();
    const link = yield* links.get(recorded.value).pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(link) &&
      DateTime.isGreaterThan(link.value.expiresAt, yield* DateTime.now) &&
      (containerUrl === null || link.value.urls.includes(containerUrl))
      ? recorded
      : Option.none<EnvironmentId>();
  });

  const status = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(progress);
    const container = yield* sandbox.status;
    const linked = yield* liveLink(container.url);
    const config = yield* readConfig;
    const base = {
      cpus: config.cpus,
      whenDone: config.whenDone,
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
                "The sandbox is running but this Mac is not linked to it at its current address. Press Start to link it.",
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
    yield* sandbox.ensure((yield* readConfig).cpus);
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

  const begin = Effect.gen(function* () {
    const alreadyRunning = yield* SubscriptionRef.modify(progress, (current) =>
      current.running
        ? ([true, current] as const)
        : ([false, { running: true, step: "Preparing the sandbox", error: null }] as const),
    );
    if (!alreadyRunning) yield* run.pipe(Effect.forkIn(scope), Effect.asVoid);
    return yield* status;
  });

  /** The user's own Start: the container is theirs now, not something a task may discard. */
  const start = Effect.gen(function* () {
    const config = yield* readConfig;
    if (config.oneOff) yield* writeConfig({ ...config, oneOff: false });
    return yield* begin;
  });

  const startForTask = Effect.gen(function* () {
    const before = yield* sandbox.status;
    const idle = !(yield* SubscriptionRef.get(progress)).running;
    const config = yield* readConfig;
    if (idle && (before.state === "missing" || before.state === "stopped") && !config.oneOff) {
      yield* writeConfig({ ...config, oneOff: true });
    }
    yield* begin;
    // The start runs in the background; wait for it to settle, not for as long as a first build can take.
    yield* SubscriptionRef.changes(progress).pipe(
      Stream.filter((current) => !current.running),
      Stream.runHead,
      Effect.timeoutOption(READY_WAIT),
    );
    return yield* status;
  });

  const asAssistantError = (error: AssistantSandbox.AssistantSandboxError) =>
    new AssistantError({ reason: "invalid", message: error.message });

  const stop = sandbox.stop.pipe(Effect.mapError(asAssistantError), Effect.andThen(status));

  const configure = Effect.fn("AssistantSandboxControl.configure")(function* (
    input: AssistantSandboxConfigureInput,
  ) {
    const current = yield* readConfig;
    const cpus = input.cpus === undefined ? current.cpus : input.cpus;
    if (cpus !== current.cpus) {
      yield* sandbox.setCpus(cpus).pipe(Effect.mapError(asAssistantError));
    }
    yield* writeConfig({
      ...current,
      cpus,
      chosen: current.chosen || input.cpus !== undefined,
      whenDone: input.whenDone ?? current.whenDone,
    });
    return yield* status;
  });

  const discardNow = Effect.gen(function* () {
    yield* sandbox.remove({ deleteVolumes: false });
    yield* SubscriptionRef.set(progress, { running: false, step: null, error: null });
    const config = yield* readConfig;
    if (config.oneOff) yield* writeConfig({ ...config, oneOff: false });
  });

  const discard = Effect.gen(function* () {
    const working = yield* sandboxAssistants;
    if (working > 0) {
      return yield* new AssistantError({
        reason: "invalid",
        message: `${working} assistant${working === 1 ? " works" : "s work"} in the container, so it stays. The user can remove it in Settings → Assistants.`,
      });
    }
    const running = yield* openTasks;
    if (running > 0) {
      return yield* new AssistantError({
        reason: "invalid",
        message: `${running} task${running === 1 ? " is" : "s are"} still running in the container. Discard it once they end.`,
      });
    }
    yield* discardNow.pipe(Effect.mapError(asAssistantError));
    return yield* status;
  });

  const taskStarted = Effect.fn("AssistantSandboxControl.taskStarted")(
    function* (environmentId: EnvironmentId, taskId: string) {
      const recorded = yield* recordedEnvironment;
      if (Option.isNone(recorded) || recorded.value !== environmentId) return;
      yield* sql`INSERT OR IGNORE INTO assistant_sandbox_task (task_id) VALUES (${taskId})`;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Assistant sandbox could not record a task", cause),
    ),
  );

  const taskEnded = Effect.fn("AssistantSandboxControl.taskEnded")(
    function* (taskId: string) {
      const deleted =
        yield* sql`DELETE FROM assistant_sandbox_task WHERE task_id = ${taskId} RETURNING task_id`;
      if (deleted.length === 0) return;
      const config = yield* readConfig;
      // One container serves every sandboxed assistant, so it stays while one needs it.
      if (
        !config.oneOff ||
        config.whenDone !== "discard" ||
        (yield* openTasks) > 0 ||
        (yield* sandboxAssistants) > 0
      ) {
        return;
      }
      yield* discardNow;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Assistant sandbox discard after a task failed", cause),
    ),
  );

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

  const pairingUrl = Effect.gen(function* () {
    const current = yield* sandbox.status;
    if (current.state !== "running" || current.url === null) {
      return yield* new AssistantSandbox.AssistantSandboxError({
        reason: "invalid",
        message: "The sandbox is not running.",
      });
    }
    const credential = yield* sandbox.pairingCredential;
    return { pairingUrl: `${current.url}/pair#token=${Redacted.value(credential)}` };
  }).pipe(Effect.mapError(asAssistantError));

  const streamStatus = Stream.merge(
    SubscriptionRef.changes(progress),
    Stream.tick(WATCH_INTERVAL),
  ).pipe(
    Stream.mapEffect(() => status),
    Stream.changesWith(sameStatus),
  );

  return AssistantSandboxControl.of({
    status,
    streamStatus,
    start,
    config: readConfig,
    configure,
    startForTask,
    discard,
    isSandbox: Effect.fn("AssistantSandboxControl.isSandbox")(function* (
      environmentId: EnvironmentId,
    ) {
      const recorded = yield* recordedEnvironment;
      return Option.isSome(recorded) && recorded.value === environmentId;
    }),
    taskStarted,
    taskEnded,
    stop,
    pairingUrl,
    remove,
  });
});

export const layer = Layer.effect(AssistantSandboxControl, make);
