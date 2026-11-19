import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";

/** Drivers whose turn ended and whose next start then ran inside the race, in this test worker. */
export const turnSlotRaceDrivers = new Set<string>();

/**
 * The turn-slot contract every adapter with a turn slot runs: the server starts the next turn as
 * soon as it reads a turn's terminal update, so by then the slot must be free. Starts the next turn
 * from the consumer of that update while every other fiber yields every few ops, the interleaving
 * where the server beats the adapter's own cleanup. Returns the next start's exit.
 */
export const startNextTurnAtTurnEnd = Effect.fnUntraced(function* <
  A,
  E,
  R,
  EventError,
  StartError,
  EndError,
>(input: {
  readonly events: Stream.Stream<ProviderAdapter.ProviderAdapterV2Event, EventError, R>;
  /** Starts the first turn; may return before the turn ends. */
  readonly startFirst: Effect.Effect<unknown, StartError, R>;
  /** Makes the provider end the first turn. */
  readonly endFirst: Effect.Effect<unknown, EndError, R>;
  readonly startNext: Effect.Effect<A, E, R>;
}) {
  const nextStart = yield* Deferred.make<Exit.Exit<A, E>>();
  const consumerReady = yield* Deferred.make<void>();
  const consumers = new Set<Fiber.Fiber<unknown, unknown>>();
  const base = new Scheduler.MixedScheduler();
  const scheduler: Scheduler.Scheduler = {
    executionMode: base.executionMode,
    makeDispatcher: () => base.makeDispatcher(),
    shouldYield: (fiber) => !consumers.has(fiber) && fiber.currentOpCount >= 3,
  };
  return yield* Effect.gen(function* () {
    yield* input.events.pipe(
      Stream.tap(() => Deferred.succeed(consumerReady, undefined)),
      Stream.filter(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status !== "running",
      ),
      Stream.take(1),
      Stream.runForEach((ended) =>
        Effect.withFiber((fiber) => {
          consumers.add(fiber);
          return Effect.exit(input.startNext).pipe(
            Effect.tap(() => Effect.sync(() => turnSlotRaceDrivers.add(ended.driver))),
            Effect.flatMap((exit) => Deferred.succeed(nextStart, exit)),
          );
        }),
      ),
      // Exempt from the moment it forks: its own stream steps would otherwise let the adapter finish.
      (consume) =>
        Effect.withFiber((fiber) => {
          consumers.add(fiber);
          return consume;
        }),
      Effect.forkScoped,
    );
    yield* input.startFirst;
    yield* Deferred.await(consumerReady);
    yield* input.endFirst;
    return yield* Deferred.await(nextStart);
  }).pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
});
