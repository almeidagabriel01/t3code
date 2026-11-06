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
          ? failure("running", `The running command cannot be ${action}; only waiting ones can.`)
          : failure("not-found", "That entry is no longer in the queue."),
      );

const unavailable = (error: unknown) => failure("unavailable", `Heavy queue unavailable: ${error}`);

export class HeavyQueue extends Context.Service<
  HeavyQueue,
  {
    readonly state: Effect.Effect<HeavyQueueState>;
    readonly stream: Stream.Stream<HeavyQueueState>;
    readonly promote: (id: string) => Effect.Effect<void, HeavyQueueError>;
    readonly cancel: (id: string) => Effect.Effect<void, HeavyQueueError>;
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

  const state = Effect.sync(() => ({ entries: QueueFile.read(dir) })).pipe(
    Effect.orElseSucceed(() => ({ entries: [] })),
  );

  const move =
    (action: string, run: (dir: string, id: string) => QueueFile.MoveResult) => (id: string) =>
      Effect.try({ try: () => run(dir, id), catch: unavailable }).pipe(
        Effect.flatMap((result) => moveFailure(action, result)),
      );

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
    promote: move("promoted", QueueFile.promote),
    cancel: move("removed", QueueFile.cancel),
    withSlot,
    command: Effect.succeed(command),
  });
});

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effect(HeavyQueue, make(dir));
