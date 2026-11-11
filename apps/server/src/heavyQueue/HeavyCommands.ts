/**
 * Every heavy command running on this server: started queue entries plus the heavy process trees
 * agents and terminals run directly. Samples only while a client watches or an agent asks.
 */
import {
  HeavyQueueError,
  type HeavyCommandsState,
  type HeavyCommandStopInput,
  type HeavyCommandStopResult,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProcessOwners } from "@t3tools/shared/ProcessOwners";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import { type Classification, classifyHeavyCommands, commandKey } from "./classifyHeavyCommands.ts";
import * as QueueFile from "./queueFile.ts";

/** Clients get at most one frame per this window; the queue sampler runs at the same pace. */
const MIN_FRAME_MS = 2_000;
/** A snapshot older than this says nothing about what runs now. */
const STALE_MS = 10_000;
const STOP_GRACE_POLLS = 10;
const STOP_GRACE_POLL = "200 millis";

/** Signal 0 only probes whether the process exists. */
export type Signal = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => boolean;

/** True when the signal was delivered; false when the process is already gone. */
const nodeSignal: Signal = (pid, signal) => {
  try {
    process.kill(pid, signal);
    return true;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH") {
      return false;
    }
    throw cause;
  }
};

const isAlive = (signal: Signal, pid: number) => {
  try {
    return signal(pid, 0);
  } catch {
    return true;
  }
};

export class HeavyCommands extends Context.Service<
  HeavyCommands,
  {
    /** Holds live telemetry sampling open for as long as it is consumed. */
    readonly stream: Stream.Stream<HeavyCommandsState>;
    /** One fresh sample, for agents. */
    readonly list: Effect.Effect<HeavyCommandsState>;
    /** Stops a direct command's process tree; queue rows stop through the queue's cancel. */
    readonly stop: (
      input: HeavyCommandStopInput,
    ) => Effect.Effect<HeavyCommandStopResult, HeavyQueueError>;
  }
>()("t3/heavyQueue/HeavyCommands") {}

interface Latest {
  readonly readAt: number;
  readonly classification: Classification;
  readonly state: HeavyCommandsState;
}

const EMPTY: Classification = { commands: [], trees: new Map(), tracked: new Map() };

const make = Effect.fn("HeavyCommands.make")(function* (options: {
  readonly dir: string;
  readonly signal: Signal;
}) {
  const telemetry = yield* ResourceTelemetry;
  const owners = yield* ProcessOwners;
  const platform = yield* HostProcess.Platform;
  const latest = yield* Ref.make<Latest>({
    readAt: Number.NEGATIVE_INFINITY,
    classification: EMPTY,
    state: { commands: [], cpuCount: 1 },
  });
  const lock = yield* Semaphore.make(1);

  // Runs per telemetry sample while watched, so it skips the span.
  const classifyUnlocked = Effect.fnUntraced(function* (
    snapshot: ResourceTelemetrySnapshot,
    minGapMs: number,
  ) {
    const readAt = DateTime.toEpochMillis(snapshot.readAt);
    const now = yield* Clock.currentTimeMillis;
    const cpuCount = snapshot.cpuCount ?? 1;
    if (now - readAt > STALE_MS) {
      return { classification: EMPTY, state: { commands: [], cpuCount } };
    }
    const current = yield* Ref.get(latest);
    if (readAt - current.readAt < minGapMs) return current;
    const classification = classifyHeavyCommands({
      processes: snapshot.processes,
      owners: yield* owners.list,
      entries: yield* Effect.sync(() => QueueFile.read(options.dir)).pipe(
        Effect.orElseSucceed(() => []),
      ),
      now: readAt,
      previous: current.classification.tracked,
    });
    const next = { readAt, classification, state: { commands: classification.commands, cpuCount } };
    yield* Ref.set(latest, next);
    return next;
  });
  const classify = (snapshot: ResourceTelemetrySnapshot, minGapMs: number) =>
    lock.withPermits(1)(classifyUnlocked(snapshot, minGapMs));

  const fresh = telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));

  const stop = Effect.fn("HeavyCommands.stop")(function* (input: HeavyCommandStopInput) {
    if (platform === "win32") {
      return yield* new HeavyQueueError({
        reason: "unavailable",
        message: "Stopping a command from here is not supported on Windows.",
      });
    }
    const snapshot = yield* fresh;
    const { classification } = yield* classify(snapshot, 0);
    const pids = classification.trees.get(commandKey(input.pid, input.startTimeMs));
    if (pids === undefined) {
      const live = snapshot.processes.some(
        (process) =>
          process.identity.pid === input.pid && process.identity.startTimeMs === input.startTimeMs,
      );
      if (!live) return { outcome: "already-exited" } satisfies HeavyCommandStopResult;
      return yield* new HeavyQueueError({
        reason: "not-found",
        message: "That process is not a command an agent or terminal runs.",
      });
    }
    const targets = pids.filter((pid) => pid !== process.pid);
    const send = (pids: ReadonlyArray<number>, name: "SIGTERM" | "SIGKILL") =>
      Effect.try({
        try: () => pids.filter((pid) => options.signal(pid, name)),
        catch: (cause) =>
          new HeavyQueueError({ reason: "unavailable", message: `Could not stop it: ${cause}` }),
      });
    if ((yield* send(targets, "SIGTERM")).length === 0) {
      return { outcome: "already-exited" } satisfies HeavyCommandStopResult;
    }
    for (let poll = 0; poll < STOP_GRACE_POLLS; poll += 1) {
      if (!targets.some((pid) => isAlive(options.signal, pid))) {
        return { outcome: "terminated" } satisfies HeavyCommandStopResult;
      }
      yield* Effect.sleep(STOP_GRACE_POLL);
    }
    yield* send(
      targets.filter((pid) => isAlive(options.signal, pid)),
      "SIGKILL",
    );
    return { outcome: "killed" } satisfies HeavyCommandStopResult;
  });

  return HeavyCommands.of({
    stream: Stream.unwrap(
      Effect.map(telemetry.subscribe, ({ latest: first, changes }) =>
        Stream.concat(Stream.make(first), changes),
      ),
    ).pipe(
      Stream.mapEffect((snapshot) => classify(snapshot, MIN_FRAME_MS)),
      Stream.map(({ state }) => state),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    ),
    list: fresh.pipe(
      Effect.flatMap((snapshot) => classify(snapshot, 0)),
      Effect.map(({ state }) => state),
    ),
    stop,
  });
});

export const layer = (options: { readonly dir?: string; readonly signal?: Signal } = {}) =>
  Layer.effect(
    HeavyCommands,
    make({ dir: options.dir ?? QueueFile.defaultQueueDir(), signal: options.signal ?? nodeSignal }),
  );
