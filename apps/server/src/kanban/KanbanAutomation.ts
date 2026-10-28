import {
  CommandId,
  type KanbanActor,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import {
  decideKanbanAutomation,
  triggersForRun,
  triggersForThread,
  type TriggerWithKey,
} from "./automation.logic.ts";
import * as Kanban from "./KanbanService.ts";
import { readThreadFacts } from "./threadFacts.ts";

const AUTOMATION = "automation" as KanbanActor;

export class KanbanAutomation extends Context.Service<
  KanbanAutomation,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/kanban/KanbanAutomation") {}

type Work =
  | { readonly kind: "sweep" }
  | { readonly kind: "threads"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly kind: "event"; readonly event: OrchestrationV2DomainEvent };

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const kanban = yield* Kanban.KanbanService;
  const sql = yield* SqlClient.SqlClient;

  const logSkipped =
    (message: string) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning(message, { cause });

  // The id names what the trigger fired for (a run, a merged pull request), so a live event and a
  // later sweep of the same state collide on one stored result and cannot move the card twice.
  // A card the user drags back by hand stays put until something new happens on the thread.
  const applyTriggers = Effect.fn("KanbanAutomation.applyTriggers")(function* (
    threadId: ThreadId,
    triggers: ReadonlyArray<TriggerWithKey>,
  ) {
    for (const { trigger, key } of triggers) {
      const found = yield* kanban.cardForThread(threadId);
      if (found === null) return;
      const decision = decideKanbanAutomation(trigger, found.card, found.board);
      if (decision.type === "skip") continue;
      const input = {
        commandId: CommandId.make(
          `server:kanban-auto:${trigger}:${found.card.id}:${threadId}:${key}`,
        ),
        actor: AUTOMATION,
        cardId: found.card.id,
        columnId: decision.columnId,
      };
      // A refusal is recorded on the card by the service and leaves it where it is.
      yield* decision.checkDefinitionOfDone
        ? kanban.cardMoveChecked(input)
        : kanban.cardMove(input);
    }
  });

  const unlinkThread = Effect.fn("KanbanAutomation.unlinkThread")(function* (threadId: ThreadId) {
    const found = yield* kanban.cardForThread(threadId);
    if (found === null) return;
    yield* kanban.cardUnlinkThread({
      commandId: CommandId.make(`server:kanban-auto:unlink:${found.card.id}:${threadId}`),
      actor: AUTOMATION,
      cardId: found.card.id,
      threadId,
    });
  });

  const handleEvent = Effect.fn("KanbanAutomation.handleEvent")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    switch (event.type) {
      case "thread.deleted":
        return yield* unlinkThread(event.threadId);
      case "run.created":
      case "run.updated":
        return yield* applyTriggers(event.threadId, triggersForRun(event.payload));
      case "thread.pull-request-synced":
        return yield* applyTriggers(
          event.threadId,
          triggersForThread({
            runs: [],
            pullRequests: (event.payload.pullRequests ?? [])
              .filter((link) => link.source !== "stack-dismissed")
              .map((link) => ({
                key: `${link.host}/${link.repository}#${link.number}`,
                state: link.snapshot?.state ?? null,
              })),
          }),
        );
      default:
        return;
    }
  });

  /** Catches up on what happened while the server was down or before a thread was linked. */
  const syncThreads = Effect.fn("KanbanAutomation.syncThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const facts = yield* readThreadFacts(sql, threadIds, { turns: false });
    for (const thread of facts.values()) {
      const threadId = thread.threadId as ThreadId;
      if (thread.deleted) yield* unlinkThread(threadId);
      else yield* applyTriggers(threadId, triggersForThread(thread));
    }
  });

  const worker = yield* makeDrainableWorker((work: Work) =>
    (work.kind === "event"
      ? handleEvent(work.event)
      : work.kind === "threads"
        ? syncThreads(work.threadIds)
        : kanban.linkedThreadIds.pipe(Effect.flatMap(syncThreads))
    ).pipe(Effect.catchCause(logSkipped("kanban automation skipped"))),
  );

  const start: KanbanAutomation["Service"]["start"] = Effect.fn("KanbanAutomation.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "thread.deleted" ||
          event.type === "run.created" ||
          event.type === "run.updated" ||
          event.type === "thread.pull-request-synced"
            ? worker.enqueue({ kind: "event", event })
            : Effect.void,
        ).pipe(Effect.catchCause(logSkipped("kanban automation event stream failed"))),
      );
      // A thread is linked after it launched, so a run that already started is only seen here.
      yield* forkParked(
        Effect.gen(function* () {
          const linked = new Map<string, ReadonlySet<string>>();
          yield* worker.enqueue({ kind: "sweep" });
          yield* Stream.runForEach(kanban.subscribe(), (item) => {
            if (item.kind === "snapshot") {
              for (const board of item.boards) {
                for (const card of board.cards) linked.set(card.id, new Set(card.linkedThreadIds));
              }
              return Effect.void;
            }
            if (item.kind === "card.removed") {
              linked.delete(item.cardId);
              return Effect.void;
            }
            if (item.kind !== "card.upserted") return Effect.void;
            const known = linked.get(item.card.id);
            linked.set(item.card.id, new Set(item.card.linkedThreadIds));
            const added = item.card.linkedThreadIds.filter((id) => !known?.has(id));
            return added.length > 0
              ? worker.enqueue({ kind: "threads", threadIds: added })
              : Effect.void;
          });
        }).pipe(Effect.catchCause(logSkipped("kanban automation link stream failed"))),
      );
    },
  );

  return { start, drain: worker.drain } satisfies KanbanAutomation["Service"];
});

export const layer = Layer.effect(KanbanAutomation, make);
