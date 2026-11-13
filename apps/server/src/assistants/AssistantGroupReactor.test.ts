import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DecisionService from "../decisions/DecisionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { AssistantGroups } from "./AssistantGroups.ts";
import * as Reactor from "./AssistantGroupReactor.ts";

it.effect(
  "starts the group's change watch, hands it every domain event and a group thread's decisions",
  () =>
    Effect.gen(function* () {
      const events = [
        { type: "run.updated" },
        { type: "thread.created" },
      ] as never as ReadonlyArray<OrchestrationV2DomainEvent>;
      const handled: string[] = [];
      const watching: string[] = [];
      const synced: string[] = [];
      const done = yield* Deferred.make<void>();
      const decided = yield* Deferred.make<void>();
      const decision = (fromThreadId: string) => ({ type: "upserted", decision: { fromThreadId } });
      const layer = Reactor.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromIterable(events),
            }),
            Layer.mock(DecisionService.DecisionService)({
              subscribe: Stream.fromIterable([
                { type: "snapshot", decisions: [] },
                decision("thread:outside"),
                decision("assistant:ada:g-0123456789abcdef"),
              ] as never),
            }),
            Layer.mock(AssistantGroups)({
              member: {} as never,
              start: Effect.sync(() => void watching.push("started")),
              syncWaitingThread: (threadId) =>
                Effect.sync(() => void synced.push(threadId)).pipe(
                  Effect.andThen(Deferred.succeed(decided, undefined)),
                  Effect.asVoid,
                ),
              handleRunEvent: (event) =>
                Effect.sync(() => void handled.push(event.type)).pipe(
                  Effect.andThen(() =>
                    handled.length === events.length
                      ? Deferred.succeed(done, undefined)
                      : Effect.void,
                  ),
                  Effect.asVoid,
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const reactor = yield* Reactor.AssistantGroupReactor;
        yield* reactor.start();
        yield* Deferred.await(done);
        yield* Deferred.await(decided);
        assert.deepEqual(watching, ["started"]);
        assert.deepEqual(handled, ["run.updated", "thread.created"]);
        assert.deepEqual(synced, ["assistant:ada:g-0123456789abcdef"]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
