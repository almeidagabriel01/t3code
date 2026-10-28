import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type KanbanBoardSnapshot,
  type KanbanCardId,
  type KanbanStreamItem,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as KanbanAutomation from "./KanbanAutomation.ts";
import * as Kanban from "./KanbanService.ts";

let counter = 0;
const cmd = () => CommandId.make(`automation-test-${++counter}`);
const thread = (id: string) => ThreadId.make(id);

const makeFixture = Effect.gen(function* () {
  const activation = yield* Deferred.make<void>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const layer = KanbanAutomation.layer.pipe(
    Layer.provideMerge(Kanban.layer),
    Layer.provideMerge(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
        Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
      ),
    ),
  );
  return { activation, events, layer };
});

const event = (type: string, threadId: string, payload: object = {}) =>
  ({
    id: EventId.make(`event-${++counter}`),
    type,
    threadId: thread(threadId),
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload,
  }) as unknown as OrchestrationV2DomainEvent;

const runEvent = (threadId: string, runId: string, status: string) =>
  event("run.updated", threadId, { id: runId, status });

const mergedPullRequest = (threadId: string) =>
  event("thread.pull-request-synced", threadId, {
    pullRequests: [
      {
        host: "github.com",
        repository: "a/b",
        number: 1,
        source: "created",
        snapshot: { state: "merged" },
      },
    ],
  });

const cardOf = (item: KanbanStreamItem, cardId: KanbanCardId) =>
  item.kind === "snapshot"
    ? item.boards.flatMap((board: KanbanBoardSnapshot) => board.cards).find((c) => c.id === cardId)
    : item.kind === "card.upserted" && item.card.id === cardId
      ? item.card
      : undefined;

type SeenCard = NonNullable<ReturnType<typeof cardOf>>;

/** Resolves once the card satisfies `done`, whether it already does or it will. */
const awaitCard = (
  kanban: Kanban.KanbanService["Service"],
  cardId: KanbanCardId,
  done: (card: SeenCard) => boolean,
) =>
  kanban.subscribe().pipe(
    Stream.map((item) => cardOf(item, cardId)),
    Stream.filter((card): card is SeenCard => card !== undefined && done(card)),
    Stream.runHead,
  );

const setup = Effect.gen(function* () {
  const kanban = yield* Kanban.KanbanService;
  const reactor = yield* KanbanAutomation.KanbanAutomation;
  const ensured = yield* kanban.boardEnsure({ commandId: cmd(), projectId: ProjectId.make("p1") });
  const boardId = ensured.boardId!;
  const snapshot = yield* kanban.subscribe().pipe(Stream.runHead);
  const board = (snapshot as { value: { boards: ReadonlyArray<KanbanBoardSnapshot> } }).value
    .boards[0]!;
  const column = (role: string) => board.columns.find((c) => c.role === role)!;
  const linkedCard = Effect.fn("linkedCard")(function* (threadId: string, title: string) {
    const { cardId } = yield* kanban.cardCreate({ commandId: cmd(), boardId, title });
    yield* kanban.cardLinkThread({ commandId: cmd(), cardId: cardId!, threadId: thread(threadId) });
    return cardId!;
  });
  // Events are handled in order, so once this card's thread is unlinked everything before it ran.
  const settle = Effect.fn("settle")(function* (events: Queue.Queue<OrchestrationV2DomainEvent>) {
    const marker = yield* linkedCard("marker-thread", "marker");
    yield* Queue.offer(events, event("thread.deleted", "marker-thread"));
    yield* awaitCard(kanban, marker, (card) => card.linkedThreadIds.length === 0);
    yield* reactor.drain;
  });
  const columnOf = (cardId: KanbanCardId) =>
    kanban.getCard({ cardId }).pipe(Effect.map((detail) => detail.card.columnId));
  return { kanban, reactor, boardId, column, linkedCard, settle, columnOf };
});

it.effect("moves linked cards along run and pull request events, never backwards", () =>
  Effect.gen(function* () {
    const { activation, events, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { kanban, reactor, boardId, column, linkedCard, settle, columnOf } = yield* setup;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      const cardId = yield* linkedCard("t1", "Work");

      yield* Queue.offer(events, runEvent("t1", "run-1", "running"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("in-progress").id);

      // The definition of done refuses the move to review and leaves the card.
      yield* Queue.offer(events, runEvent("t1", "run-1", "completed"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("in-progress").id);
      const refused = (yield* kanban.getCard({ cardId })).activity.filter(
        (item) => item.kind === "dod-refused",
      );
      assert.deepEqual(
        refused.map((item) => item.actor),
        ["automation"],
      );

      // The same run again does not log the refusal twice.
      yield* Queue.offer(events, runEvent("t1", "run-1", "completed"));
      yield* settle(events);
      assert.strictEqual(
        (yield* kanban.getCard({ cardId })).activity.filter((item) => item.kind === "dod-refused")
          .length,
        1,
      );

      // A later completed run with the same missing items is not new information.
      yield* Queue.offer(events, runEvent("t1", "run-1b", "completed"));
      yield* settle(events);
      assert.strictEqual(
        (yield* kanban.getCard({ cardId })).activity.filter((item) => item.kind === "dod-refused")
          .length,
        1,
      );

      // A failed run is not completed work.
      yield* kanban.boardUpdate({
        commandId: cmd(),
        boardId,
        automations: { definitionOfDone: false },
      });
      yield* Queue.offer(events, runEvent("t1", "run-2", "failed"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("in-progress").id);

      yield* Queue.offer(events, runEvent("t1", "run-3", "completed"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("review").id);

      // A merged pull request moves to done even with the definition of done on.
      yield* kanban.boardUpdate({
        commandId: cmd(),
        boardId,
        automations: { definitionOfDone: true },
      });
      yield* Queue.offer(events, mergedPullRequest("t1"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("done").id);

      yield* Queue.offer(events, runEvent("t1", "run-4", "running"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(cardId), column("done").id);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("leaves archived cards, disabled automations and unlinked threads alone", () =>
  Effect.gen(function* () {
    const { activation, events, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { kanban, reactor, boardId, column, linkedCard, settle, columnOf } = yield* setup;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      const archived = yield* linkedCard("t-archived", "Archived");
      yield* kanban.cardArchive({ commandId: cmd(), cardId: archived });
      const plain = yield* linkedCard("t-off", "Off");
      yield* kanban.boardUpdate({
        commandId: cmd(),
        boardId,
        automations: { threadStarted: false },
      });

      yield* Queue.offer(events, runEvent("t-archived", "r", "running"));
      yield* Queue.offer(events, runEvent("t-off", "r", "running"));
      yield* Queue.offer(events, runEvent("nobody", "r", "running"));
      yield* settle(events);
      assert.strictEqual(yield* columnOf(archived), column("backlog").id);
      assert.strictEqual(yield* columnOf(plain), column("backlog").id);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("unlinks a deleted thread from its card", () =>
  Effect.gen(function* () {
    const { activation, events, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { kanban, reactor, linkedCard, settle } = yield* setup;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      const cardId = yield* linkedCard("t-del", "Gone soon");
      yield* Queue.offer(events, event("thread.deleted", "t-del"));
      yield* settle(events);
      const detail = yield* kanban.getCard({ cardId });
      assert.deepEqual(detail.card.linkedThreadIds, []);
      assert.strictEqual(detail.activity.at(-1)!.kind, "unlinked");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("catches up on startup with what happened while the server was down", () =>
  Effect.gen(function* () {
    const { activation, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { kanban, reactor, column, linkedCard } = yield* setup;
      const json = JSON.stringify;
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: "t-merged",
        project_id: "p1",
        title: "Merged while down",
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        payload_json: json({
          title: "Merged while down",
          pullRequests: [
            {
              host: "github.com",
              repository: "a/b",
              number: 4,
              url: "https://github.com/a/b/pull/4",
              source: "created",
              snapshot: { state: "merged" },
            },
          ],
        }),
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: "run-a",
        thread_id: "t-merged",
        ordinal: 1,
        provider: "codex",
        status: "completed",
        requested_at: "2026-01-01T00:00:00.000Z",
        payload_json: "{}",
      })}`;
      const merged = yield* linkedCard("t-merged", "Merged");
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: "t-ghost",
        project_id: "p1",
        title: "Deleted while down",
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: "2026-01-02T00:00:00.000Z",
        payload_json: "{}",
      })}`;
      const ghost = yield* linkedCard("t-ghost", "Ghost");

      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      yield* awaitCard(kanban, merged, (card) => card.columnId === column("done").id);
      // A thread deleted while the server was down is unlinked.
      yield* awaitCard(kanban, ghost, (card) => card.linkedThreadIds.length === 0);
      yield* reactor.drain;
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("sweeps when a thread is linked after its run already started", () =>
  Effect.gen(function* () {
    const { activation, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { kanban, reactor, boardId, column } = yield* setup;
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: "t-late",
        project_id: "p1",
        title: "Late link",
        default_provider: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
        run_id: "run-late",
        thread_id: "t-late",
        ordinal: 1,
        provider: "codex",
        status: "running",
        requested_at: "2026-01-01T00:00:00.000Z",
        payload_json: "{}",
      })}`;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      const { cardId } = yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Late" });
      yield* kanban.cardLinkThread({
        commandId: cmd(),
        cardId: cardId!,
        threadId: thread("t-late"),
      });
      yield* awaitCard(kanban, cardId!, (card) => card.columnId === column("in-progress").id);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("moves the parent to review when its last subtask reaches done", () =>
  Effect.gen(function* () {
    const { activation, events, layer } = yield* makeFixture;
    yield* Effect.gen(function* () {
      const { kanban, reactor, boardId, column, settle } = yield* setup;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      yield* settle(events);
      const parent = (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "Parent" }))
        .cardId!;
      const [a, b] = [
        (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "A", parentCardId: parent }))
          .cardId!,
        (yield* kanban.cardCreate({ commandId: cmd(), boardId, title: "B", parentCardId: parent }))
          .cardId!,
      ];
      yield* kanban.cardMove({ commandId: cmd(), cardId: a, columnId: column("done").id });
      yield* kanban.cardMove({ commandId: cmd(), cardId: b, columnId: column("done").id });
      yield* awaitCard(kanban, parent, (card) => card.columnId === column("review").id);
      yield* reactor.drain;
    }).pipe(Effect.provide(layer));
  }),
);
