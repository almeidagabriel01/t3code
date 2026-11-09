/**
 * The machine-wide heavy-work queue, shared with every T3 server and `t3 heavy` CLI on this
 * machine through one file. Agents and the server wait their turn here; only the user reorders.
 */
// @effect-diagnostics nodeBuiltinImport:off - An entry id needs no Effect service.
import * as NodeCrypto from "node:crypto";
import { HeavyQueueError, type HeavyQueueState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { SAMPLE_FRESH_MS } from "./admission.ts";
import * as QueueFile from "./queueFile.ts";

const POLL_INTERVAL = "1 second";
const STREAM_INTERVAL = "2 seconds";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const failure = (reason: HeavyQueueError["reason"], message: string) =>
  new HeavyQueueError({ reason, message });

const moveFailure = (action: string, result: QueueFile.MoveResult) =>
  result === "ok"
    ? Effect.void
    : Effect.fail(
        result === "running"
          ? failure("running", `The running command cannot be ${action}.`)
          : failure("not-found", "That entry is no longer in the queue."),
      );

const unavailable = (error: unknown) => failure("unavailable", `Heavy queue unavailable: ${error}`);

export class HeavyQueue extends Context.Service<
  HeavyQueue,
  {
    readonly state: Effect.Effect<HeavyQueueState>;
    readonly stream: Stream.Stream<HeavyQueueState>;
    /** Runs a waiter next; `note` records who asked, for agents acting on the user's request. */
    readonly promote: (id: string, note?: string) => Effect.Effect<void, HeavyQueueError>;
    /** Puts a waiter before `beforeId`, or last when null. */
    readonly move: (id: string, beforeId: string | null) => Effect.Effect<void, HeavyQueueError>;
    /** Removes a waiter, or stops the running `t3 heavy` command. */
    readonly cancel: (id: string) => Effect.Effect<void, HeavyQueueError>;
    /** How many entries may run at once; 1 is strictly one at a time. */
    readonly setMaxRunning: (maxRunning: number) => Effect.Effect<void, HeavyQueueError>;
    readonly setPaused: (paused: boolean) => Effect.Effect<void, HeavyQueueError>;
    /** A null priority clears the folder's rule. */
    readonly setRule: (
      root: string,
      priority: "first" | "last" | null,
    ) => Effect.Effect<void, HeavyQueueError>;
    /** Runs `effect` once this server holds the slot; frees it on completion, failure or interrupt. */
    readonly withSlot: <A, E, R>(
      label: string,
      threadId: string | null,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HeavyQueueError, R>;
    /** The shell prefix agents put before a heavy command. */
    readonly command: Effect.Effect<string>;
  }
>()("t3/heavyQueue/HeavyQueue") {}

const make = Effect.fn("HeavyQueue.make")(function* (dir: string) {
  const invocation = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  const command = [
    // Packaged desktop's executable is Electron, which opens the app instead of running the CLI without this.
    ...(platform === "win32" ? [] : ["ELECTRON_RUN_AS_NODE=1"]),
    shellQuote(invocation.command),
    ...(invocation.entrypoint === undefined ? [] : [shellQuote(invocation.entrypoint)]),
    "heavy",
    "--queue-dir",
    shellQuote(dir),
    "--",
  ].join(" ");

  const state = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const { doc, plan } = QueueFile.readPlan(dir, now);
    const { entries, paused, rules, maxRunning, sample } = doc;
    const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
    return {
      entries,
      paused,
      rules,
      maxRunning,
      reasons: plan.reasons,
      room: plan.room,
      machine: fresh
        ? {
            busyCores: sample.busyCores,
            cpuCount: sample.cpuCount,
            availableMemoryBytes: sample.availableMemoryBytes,
            totalMemoryBytes: sample.totalMemoryBytes,
          }
        : null,
    };
  });

  const act = (action: string, run: () => QueueFile.MoveResult) =>
    Effect.try({ try: run, catch: unavailable }).pipe(
      Effect.flatMap((result) => moveFailure(action, result)),
    );
  const change = (run: () => void) => Effect.try({ try: run, catch: unavailable });

  const withSlot = Effect.fnUntraced(function* <A, E, R>(
    label: string,
    threadId: string | null,
    effect: Effect.Effect<A, E, R>,
  ) {
    // Spans would only repeat the one-second poll; the caller's tool span covers the wait.
    const id = NodeCrypto.randomUUID();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          QueueFile.enqueue(dir, {
            id,
            pid: process.pid,
            threadId,
            label,
            cwd: process.cwd(),
            createdAt,
            startedAt: null,
            server: true,
          }),
        catch: unavailable,
      }),
      () =>
        Effect.gen(function* () {
          while (true) {
            const start = yield* Effect.try({
              try: () => QueueFile.tryStart(dir, id),
              catch: unavailable,
            });
            if (start.status === "started") break;
            if (start.status === "removed") {
              return yield* failure("not-found", "The user removed this from the heavy queue.");
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
          return yield* effect;
        }),
      () => Effect.sync(() => QueueFile.remove(dir, id)).pipe(Effect.ignore),
    );
  });

  return HeavyQueue.of({
    state,
    stream: Stream.tick(STREAM_INTERVAL).pipe(
      Stream.mapEffect(() => state),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    ),
    promote: Effect.fn("HeavyQueue.promote")((id: string, note?: string) =>
      act("promoted", () => QueueFile.promote(dir, id, note)),
    ),
    move: Effect.fn("HeavyQueue.move")((id: string, beforeId: string | null) =>
      act("moved", () => QueueFile.move(dir, id, beforeId, "Moved by the user")),
    ),
    cancel: Effect.fn("HeavyQueue.cancel")((id: string) =>
      act("stopped from here", () => QueueFile.cancel(dir, id)),
    ),
    setMaxRunning: Effect.fn("HeavyQueue.setMaxRunning")((maxRunning: number) =>
      change(() => QueueFile.setMaxRunning(dir, maxRunning)),
    ),
    setPaused: Effect.fn("HeavyQueue.setPaused")((paused: boolean) =>
      change(() => QueueFile.setPaused(dir, paused)),
    ),
    setRule: Effect.fn("HeavyQueue.setRule")((root: string, priority: "first" | "last" | null) =>
      change(() => QueueFile.setRule(dir, root, priority)),
    ),
    withSlot,
    command: Effect.succeed(command),
  });
});

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effect(HeavyQueue, make(dir));
