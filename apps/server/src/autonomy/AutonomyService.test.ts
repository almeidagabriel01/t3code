import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type AutonomyError,
  DEFAULT_ASSISTANT_AUTONOMY,
  DEFAULT_AUTONOMY_SETTINGS,
  type AssistantAutonomy,
  type AutonomySettings,
  type KanbanStreamItem,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AssistantSpend } from "../assistants/AssistantSpend.ts";
import { ChannelLanguage } from "../channels/ChannelLanguage.ts";
import * as ImessageChannelSettings from "../channels/imessage/ImessageChannelSettings.ts";
import * as ChannelOutbox from "../channels/ChannelOutbox.ts";
import { outboxRows } from "../channels/channelBridgeTestSupport.ts";
import * as ChannelTransport from "../channels/ChannelTransport.ts";
import * as TelegramChannelSettings from "../channels/telegram/TelegramChannelSettings.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as KanbanService from "../kanban/KanbanService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Autonomy from "./AutonomyService.ts";
import { requestThreadId } from "../assistants/AssistantGroups.ts";

const awake: AssistantAutonomy = {
  mode: "reply-and-notify",
  rules: null,
  projectIds: null,
  channels: null,
};
const ON: AutonomySettings = { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true };

type Shell = {
  title: string;
  projectId: string;
  providerInstanceId?: string;
  archivedAt?: string | null;
  lineage: { relationshipToParent: string | null };
  sideChatOf?: unknown;
  delegatedFrom?: unknown;
};
// Real shells omit `sideChatOf` unless the thread is a side chat.
const plain: Shell = {
  title: "Fix login",
  projectId: "p1",
  archivedAt: null,
  lineage: { relationshipToParent: null },
};

const harness = (language: "en" | "pt-BR" = "en") => {
  const settings = Ref.makeUnsafe<AutonomySettings>(ON);
  const shells = new Map<string, Shell | null>();
  const sent: Array<{ threadId: string; text: string; messageId: string }> = [];
  const refusal = { current: false };
  const sendFails = { current: false };
  const telegram = Ref.makeUnsafe({
    enabled: true,
    tokenConfigured: true,
    allowedUserIds: ["4242", "7"],
  });
  const answers = new Map<string, string>();
  /** What getRuntimeResponseContext returns, by request id. */
  const contexts = new Map<string, { request: unknown; item?: unknown }>();
  const imessage = Ref.makeUnsafe<{ enabled: boolean; selfHandles: ReadonlyArray<string> }>({
    enabled: false,
    selfHandles: [],
  });
  const dispatched: Array<Record<string, unknown>> = [];
  const layer = Autonomy.layer.pipe(
    Layer.provideMerge(ChannelOutbox.layer),
    Layer.provideMerge(DecisionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ChannelTransport.layer,
        ChannelLanguage.layerFixed(language),
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            sendFails.current
              ? Effect.fail(new Error("nope") as never)
              : Effect.sync(() => {
                  sent.push({
                    threadId: input.threadId,
                    text: input.text,
                    messageId: input.messageId,
                  });
                  return {} as never;
                }),
          getThreadRecords: (threadId) =>
            Effect.succeed({
              messages: [{ text: answers.get(threadId) ?? "" }],
              turnItems: [...contexts.values()].flatMap((context) =>
                context.item === undefined ? [] : [context.item],
              ),
              runtimeRequests: [...contexts.values()].map((context) => context.request),
            } as never),
          dispatch: (command) => Effect.sync(() => void dispatched.push(command as never)) as never,
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeResponseContext: (_threadId, requestId) =>
            Effect.succeed(
              (contexts.get(requestId) ?? { request: undefined, item: undefined }) as never,
            ),
        }),
        Layer.mock(ImessageChannelSettings.ImessageChannelSettings)({
          get: Ref.get(imessage).pipe(Effect.map((value) => value as never)),
        }),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed("env-1" as never),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Ref.get(settings).pipe(Effect.map((autonomy) => ({ autonomy }) as never)),
        }),
        Layer.mock(AssistantSpend)({
          budgetRefusal: () =>
            Effect.succeed(refusal.current ? Option.some({} as never) : Option.none()),
        }),
        Layer.mock(TelegramChannelSettings.TelegramChannelSettings)({
          get: Ref.get(telegram).pipe(Effect.map((value) => value as never)),
        }),
        Layer.mock(KanbanService.KanbanService)({ subscribe: () => Stream.empty }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ title: "acme/app" } as never),
        }),
      ),
    ),
  );
  return {
    layer,
    settings,
    shells,
    sent,
    refusal,
    sendFails,
    telegram,
    answers,
    contexts,
    imessage,
    dispatched,
  };
};

const addAssistant = (autonomy: AssistantAutonomy = awake, id = "jarvis") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, autonomy_json, created_at, updated_at)
      VALUES (${id}, ${id}, ${id === "jarvis" ? "Jarvis" : id}, 'p1', 'full', ${`assistant:${id}:1`},
        ${JSON.stringify(autonomy)}, '2026-01-01', '2026-01-01')`;
  });

const ev = (type: string, threadId: string, payload: Record<string, unknown>, runId?: string) =>
  ({
    type,
    threadId,
    ...(runId === undefined ? {} : { runId }),
    payload,
  }) as unknown as OrchestrationV2DomainEvent;
const run = (status: string, id: string, threadId = "t1", userMessageId = "m1") =>
  ev("run.updated", threadId, { id, threadId, status, userMessageId }, id);
const MIN = 60_000;

it.effect("a failed run wakes an assistant once, however often the event replays", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    h.shells.set("t1", plain);
    for (const status of ["running", "failed", "failed"])
      yield* service.handleEvent(run(status, "r1"));
    assert.lengthOf(h.sent, 1);
    assert.equal(h.sent[0]!.threadId, "assistant:jarvis:1");
    assert.include(h.sent[0]!.text, "Run failed or was interrupted");
    assert.include(h.sent[0]!.text, "Project: acme/app");
    assert.include(h.sent[0]!.text, "Do not change anything.");
  }).pipe(Effect.provide(h.layer));
});

it.effect("assistant, subagent, delegated and side-chat threads never trigger", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    h.shells.set("assistant:other:1", plain);
    h.shells.set("sub", { ...plain, lineage: { relationshipToParent: "subagent" } });
    h.shells.set("deleg", { ...plain, delegatedFrom: { threadId: "x" } });
    h.shells.set("side", { ...plain, sideChatOf: { threadId: "x" } });
    h.shells.set("gone", null);
    for (const [index, threadId] of [
      "assistant:other:1",
      "sub",
      "deleg",
      "side",
      "gone",
    ].entries()) {
      yield* service.handleEvent(run("failed", `r${index}`, threadId));
    }
    assert.lengthOf(h.sent, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("the pause switch stops everything at once, and turning it on resumes", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    h.shells.set("t1", plain);
    yield* Ref.set(h.settings, { ...ON, enabled: false });
    yield* service.handleEvent(run("failed", "r1"));
    yield* service.handleEvent(run("running", "r2"));
    yield* TestClock.adjust(60 * MIN);
    yield* service.sweep;
    assert.lengthOf(h.sent, 0);
    yield* Ref.set(h.settings, ON);
    yield* service.handleEvent(run("failed", "r1"));
    assert.lengthOf(h.sent, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a reply-only assistant never wakes on a rule, but a watch it was asked for wakes it",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant({ ...awake, mode: "reply-only" });
      h.shells.set("t1", plain);
      yield* service.upsertWatch({
        assistantId: "jarvis",
        title: "any finish",
        filter: { event: "run_finished" },
        instruction: "",
        oneShot: false,
        expiresAt: null,
      });
      yield* service.handleEvent(run("failed", "r1"));
      assert.lengthOf(h.sent, 0);
      yield* service.handleEvent(run("completed", "r2"));
      assert.lengthOf(h.sent, 1);
      assert.include(h.sent[0]!.text, "Watch: any finish");
      h.shells.set("assistant:jarvis:1", { ...plain, title: "Jarvis" });
      h.answers.set("assistant:jarvis:1", "r2 finished green.");
      yield* service.handleEvent(
        run("completed", "wake-run", "assistant:jarvis:1", h.sent[0]!.messageId),
      );
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.equal(rows[0]!.message.destination.kind, "telegram");
      assert.include(rows[0]!.message.text, "r2 finished green.");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a one-shot watch on a delegated task wakes its assistant; nothing else passes the loop guard",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
      yield* addAssistant(awake, "ana");
      h.shells.set("deleg", { ...plain, delegatedFrom: { threadId: "x" } });
      h.shells.set("assistant:jarvis:1", plain);
      const watch = (title: string, threadId: string, oneShot = true, assistantId = "jarvis") =>
        service.upsertWatch({
          assistantId,
          title,
          filter: { event: "run_finished", threadId: threadId as never },
          instruction: "",
          oneShot,
          expiresAt: null,
        });
      yield* watch("task done", "deleg");
      yield* watch("kept on", "deleg", false, "ana");
      // An assistant watching its own thread would wake on its own answer.
      yield* watch("myself", "assistant:jarvis:1");
      yield* service.handleEvent(run("completed", "r1", "deleg"));
      yield* service.handleEvent(run("completed", "r2", "assistant:jarvis:1"));
      assert.deepEqual(
        h.sent.map((wake) => [wake.threadId, wake.text.split("\n")[0]]),
        [["assistant:jarvis:1", "[Autonomy] Watch: task done"]],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rule wakes keep a minimum interval per thread and a daily cap", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    yield* Ref.set(h.settings, { ...ON, maxWakesPerDay: 3 });
    h.shells.set("t1", plain);
    yield* service.handleEvent(run("failed", "r1"));
    yield* service.handleEvent(run("failed", "r2"));
    assert.lengthOf(h.sent, 1);
    yield* TestClock.adjust(6 * MIN);
    yield* service.handleEvent(run("failed", "r3"));
    assert.lengthOf(h.sent, 2);
    yield* TestClock.adjust(6 * MIN);
    yield* service.handleEvent(run("failed", "r4"));
    yield* TestClock.adjust(6 * MIN);
    yield* service.handleEvent(run("failed", "r5"));
    assert.lengthOf(h.sent, 3);
    yield* TestClock.adjust(24 * 60 * MIN);
    yield* service.handleEvent(run("failed", "r6"));
    assert.lengthOf(h.sent, 4);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a blocking budget, a failed send and a missing assistant wake nobody", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    h.shells.set("t1", plain);
    yield* service.handleEvent(run("failed", "none"));
    yield* addAssistant();
    h.refusal.current = true;
    yield* service.handleEvent(run("failed", "r1"));
    h.refusal.current = false;
    h.sendFails.current = true;
    yield* service.handleEvent(run("failed", "r2"));
    assert.lengthOf(h.sent, 0);
    // The failed send gave its claim back, so the same occurrence may wake later.
    h.sendFails.current = false;
    yield* service.handleEvent(run("failed", "r2"));
    assert.lengthOf(h.sent, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a run stuck past the threshold wakes once; waiting on an approval never counts", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    h.shells.set("t1", plain);
    h.shells.set("t2", plain);
    yield* service.handleEvent(run("running", "stuck", "t1"));
    yield* service.handleEvent(run("running", "approval", "t2"));
    yield* service.handleEvent(run("waiting", "approval", "t2"));
    yield* TestClock.adjust(14 * MIN);
    yield* service.sweep;
    assert.lengthOf(h.sent, 0);
    // Activity on the run resets the clock.
    yield* service.handleEvent(ev("turn-item.updated", "t1", {}, "stuck"));
    yield* TestClock.adjust(14 * MIN);
    yield* service.sweep;
    assert.lengthOf(h.sent, 0);
    yield* TestClock.adjust(2 * MIN);
    yield* service.sweep;
    yield* service.sweep;
    assert.lengthOf(h.sent, 1);
    assert.include(h.sent[0]!.text, "Run looks stuck");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a request or decision open past waitingMinutes wakes; a resolved one does not", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const decisions = yield* DecisionService.DecisionService;
    yield* addAssistant();
    h.shells.set("t1", plain);
    h.shells.set("t2", plain);
    h.shells.set("t3", plain);
    const request = (id: string, threadId: string, status: string) =>
      ev("runtime-request.updated", threadId, { id, status });
    yield* service.handleEvent(request("q1", "t1", "pending"));
    yield* service.handleEvent(request("q2", "t2", "pending"));
    yield* service.handleEvent(request("q2", "t2", "resolved"));
    yield* decisions.request({
      fromThreadId: "t3" as never,
      projectId: "p1" as never,
      threadTitle: "t3",
      clientRequestId: "d1",
      title: "Ship it?",
      context: "",
      options: [{ id: "y", label: "Yes" }],
    });
    // A run that ended leaves no one waiting.
    h.shells.set("t4", plain);
    yield* service.handleEvent(request("q4", "t4", "pending"));
    yield* service.handleEvent(run("interrupted", "r4", "t4"));
    const before = h.sent.length;
    yield* TestClock.adjust(29 * MIN);
    yield* service.sweep;
    assert.lengthOf(h.sent, before);
    yield* TestClock.adjust(2 * MIN);
    yield* service.sweep;
    assert.lengthOf(h.sent, before + 2);
    assert.isTrue(
      h.sent.slice(before).every((message) => message.text.includes("Waiting for you too long")),
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "PR checks failing wake once per transition; a one-shot watch on passing then disables",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant();
      h.shells.set("t1", plain);
      const link = (checksState: string, updatedAt: string) =>
        ev("thread.pull-request-link-updated", "t1", {
          number: 7,
          url: "https://example.com/pr/7",
          snapshot: { checksState, updatedAt, syncedAt: updatedAt },
        });
      const watch = yield* service.upsertWatch({
        assistantId: "jarvis",
        title: "PR 7 green",
        filter: { event: "pr_checks_passed", prNumber: 7 },
        instruction: "Say if it can merge.",
        oneShot: true,
        expiresAt: null,
      });
      yield* service.handleEvent(link("pending", "a"));
      yield* service.handleEvent(link("failing", "b"));
      yield* service.handleEvent(link("failing", "b"));
      assert.lengthOf(h.sent, 1);
      assert.include(h.sent[0]!.text, "PR checks failed");
      yield* service.handleEvent(link("passing", "c"));
      assert.lengthOf(h.sent, 2);
      assert.include(h.sent[1]!.text, "Instruction from the user: Say if it can merge.");
      const [stored] = yield* service.listWatches;
      assert.equal(stored!.id, watch.id);
      assert.equal(stored!.triggerCount, 1);
      assert.isFalse(stored!.enabled);
      yield* service.handleEvent(link("failing", "d"));
      yield* service.handleEvent(link("passing", "e"));
      assert.lengthOf(h.sent, 2);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a paused or deleted watch stops matching at once; a card move reaches a card watch",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant({ ...awake, rules: [] });
      h.shells.set("t1", plain);
      const watch = yield* service.upsertWatch({
        assistantId: "jarvis",
        title: "finishes",
        filter: { event: "run_finished", projectId: "p1" as never },
        instruction: "",
        oneShot: false,
        expiresAt: null,
      });
      yield* service.handleEvent(run("completed", "r1"));
      assert.lengthOf(h.sent, 1);
      yield* service.setWatchEnabled({ id: watch.id, enabled: false });
      yield* service.handleEvent(run("completed", "r2"));
      assert.lengthOf(h.sent, 1);
      yield* service.setWatchEnabled({ id: watch.id, enabled: true });
      yield* service.handleEvent(run("completed", "r3"));
      assert.lengthOf(h.sent, 2);
      yield* service.deleteWatch({ id: watch.id });
      yield* service.handleEvent(run("completed", "r4"));
      assert.lengthOf(h.sent, 2);

      yield* service.upsertWatch({
        assistantId: "jarvis",
        title: "cards",
        filter: { event: "card_moved", projectId: "p1" as never },
        instruction: "",
        oneShot: false,
        expiresAt: null,
      });
      const board = {
        id: "b1",
        projectId: "p1",
        columns: [
          { id: "c1", name: "Todo" },
          { id: "c2", name: "Review" },
        ],
        cards: [{ id: "k1", columnId: "c1" }],
      };
      const card = (columnId: string) =>
        ({
          kind: "card.upserted",
          sequence: 1,
          card: {
            id: "k1",
            boardId: "b1",
            columnId,
            number: 9,
            title: "Ship",
            updatedAt: columnId,
          },
        }) as unknown as KanbanStreamItem;
      yield* service.handleKanban({ kind: "snapshot", sequence: 0, boards: [board] } as never);
      yield* service.handleKanban(card("c1"));
      yield* service.handleKanban(card("c2"));
      yield* service.handleKanban(card("c2"));
      assert.lengthOf(h.sent, 3);
      assert.include(h.sent[2]!.text, 'Card #9 "Ship" moved to Review.');
      yield* service.handleKanban({ kind: "board.upserted", sequence: 2, board } as never);
      yield* service.handleKanban({ kind: "card.removed", sequence: 3 } as never);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a card entering Review with unchecked items wakes once per entry, per card", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    const columns = [
      { id: "c1", name: "Doing", role: "in-progress" },
      { id: "c2", name: "Review", role: "review" },
    ];
    const item = (done: boolean) => ({ id: "i1", text: "Add tests", done });
    const card = (
      id: string,
      columnId: string,
      done: boolean,
      updatedAt: string,
      archivedAt: string | null = null,
    ) => ({
      id,
      boardId: "b1",
      columnId,
      number: id === "k1" ? 9 : 10,
      title: id === "k1" ? "Ship" : "Polish",
      checklist: [item(done)],
      archivedAt,
      updatedAt,
    });
    const upsert = (value: ReturnType<typeof card>) =>
      service.handleKanban({ kind: "card.upserted", sequence: 1, card: value } as never);
    // A card already waiting in Review at startup is not news.
    yield* service.handleKanban({
      kind: "snapshot",
      sequence: 0,
      boards: [{ id: "b1", projectId: "p1", columns, cards: [card("k2", "c2", false, "t0")] }],
    } as never);
    yield* upsert(card("k2", "c2", false, "t1"));
    assert.lengthOf(h.sent, 0);

    yield* upsert(card("k1", "c1", false, "t1"));
    yield* upsert(card("k1", "c2", false, "t2"));
    yield* upsert(card("k1", "c2", false, "t3"));
    assert.lengthOf(h.sent, 1);
    assert.include(h.sent[0]!.text, "Card in Review with open items");
    assert.include(
      h.sent[0]!.text,
      'Card #9 "Ship" is in Review with 1 unchecked item(s): Add tests.',
    );

    // Done items, or an archived card, leave the state; another card is spaced on its own.
    yield* upsert(card("k1", "c2", true, "t4"));
    yield* upsert(card("k2", "c2", false, "t5", "2026-01-01"));
    yield* upsert(card("k2", "c1", false, "t6"));
    yield* upsert(card("k2", "c2", false, "t7"));
    assert.lengthOf(h.sent, 2);
    assert.include(h.sent[1]!.text, 'Card #10 "Polish"');

    // Re-entering the state wakes again only after the per-card interval.
    yield* upsert(card("k1", "c2", false, "t8"));
    assert.lengthOf(h.sent, 2);
    yield* TestClock.adjust(2 * 60 * MIN);
    yield* upsert(card("k1", "c2", true, "t9"));
    yield* upsert(card("k1", "c2", false, "t10"));
    assert.lengthOf(h.sent, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "watch storage rejects an unknown assistant, a missing watch and keeps fields on update",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant();
      const base = {
        title: "w",
        filter: { event: "run_failed" as const },
        instruction: "",
        oneShot: false,
        expiresAt: null,
      };
      const unknown = yield* Effect.flip(service.upsertWatch({ ...base, assistantId: "ghost" }));
      assert.equal(unknown.reason, "invalid");
      const blank = yield* Effect.flip(
        service.upsertWatch({ ...base, title: " ", assistantId: "jarvis" }),
      );
      assert.equal(blank.reason, "invalid");
      const missing = yield* Effect.flip(service.deleteWatch({ id: "nope" as never }));
      assert.equal(missing.reason, "not_found");
      const created = yield* service.upsertWatch({
        ...base,
        assistantId: "jarvis",
        enabled: false,
      });
      assert.isFalse(created.enabled);
      const edited = yield* service.upsertWatch({
        ...base,
        assistantId: "jarvis",
        id: created.id,
        title: "renamed",
      });
      assert.equal(edited.title, "renamed");
      assert.isFalse(edited.enabled);
      const reenabled = yield* service.upsertWatch({
        ...base,
        assistantId: "jarvis",
        id: created.id,
        enabled: true,
      });
      assert.isTrue(reenabled.enabled);
    }).pipe(Effect.provide(h.layer));
  },
);

const wakeThenFinish = (
  h: ReturnType<typeof harness>,
  extra?: () => Effect.Effect<void, never, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* addAssistant();
    h.shells.set("t1", plain);
    h.shells.set("assistant:jarvis:1", { ...plain, title: "Jarvis" });
    if (extra !== undefined) yield* extra();
    yield* service.handleEvent(run("failed", "r1"));
    const messageId = h.sent[0]!.messageId;
    h.answers.set("assistant:jarvis:1", "It failed on a missing env var.");
    yield* service.handleEvent(run("completed", "wake-run", "assistant:jarvis:1", messageId));
    return service;
  });

it.effect(
  "a finished wake reaches the owner's Telegram chat with no reply target, and Activity as a notice",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* wakeThenFinish(h);
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.deepEqual(rows[0]!.message.destination, {
        kind: "telegram",
        connectionId: "telegram",
        chatId: "4242",
      });
      assert.include(rows[0]!.message.text, "It failed on a missing env var.");
      assert.equal(rows[0]!.message.senderName, "Jarvis");
      const decisions = yield* DecisionService.DecisionService;
      const [notice] = yield* decisions.list({});
      assert.equal(notice!.options[0]!.label, "Got it");
      assert.isTrue(notice!.notice);
      assert.include(notice!.context, "missing env var");
      const before = h.sent.length;
      yield* decisions.dismiss(notice!.id);
      assert.lengthOf(h.sent, before);
      assert.isDefined((yield* decisions.get(notice!.id)).deliveredAt);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "in Portuguese the Telegram wake notice names the rule in Portuguese; the Activity notice stays English",
  () => {
    const h = harness("pt-BR");
    return Effect.gen(function* () {
      yield* wakeThenFinish(h);
      const [row] = yield* outboxRows;
      assert.equal(
        row!.message.text,
        "A execução falhou ou foi interrompida\n\nIt failed on a missing env var.",
      );
      assert.equal(row!.message.language, "pt-BR");
      const [notice] = yield* (yield* DecisionService.DecisionService).list({});
      assert.include(notice!.title, "Run failed or was interrupted");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "delivery follows the channels: t3 only, telegram only, already chatting on Telegram, no token",
  () => {
    const cases = [
      { channels: ["t3"] as const, outbox: 0, notices: 1, target: false, token: true },
      { channels: ["telegram"] as const, outbox: 1, notices: 0, target: false, token: true },
      { channels: ["telegram"] as const, outbox: 0, notices: 0, target: true, token: true },
      { channels: ["telegram"] as const, outbox: 0, notices: 0, target: false, token: false },
    ];
    return Effect.forEach(
      cases,
      (row) => {
        const h = harness();
        return Effect.gen(function* () {
          yield* Ref.update(h.telegram, (value) => ({ ...value, tokenConfigured: row.token }));
          yield* wakeThenFinish(h, () =>
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE assistants SET autonomy_json = ${JSON.stringify({ ...awake, channels: row.channels })}`;
              if (row.target) {
                yield* sql`
              INSERT INTO channel_reply_targets (assistant_id, address_json, actor_id)
              VALUES ('jarvis', '{"kind":"telegram","connectionId":"telegram","chatId":"4242"}', '4242')`;
              }
            }).pipe(Effect.orDie),
          );
          assert.lengthOf(yield* outboxRows, row.outbox);
          const decisions = yield* DecisionService.DecisionService;
          assert.lengthOf(yield* decisions.list({}), row.notices);
        }).pipe(Effect.provide(h.layer));
      },
      { discard: true },
    );
  },
);

it.effect("a failed wake run delivers its error, and a paused server delivers nothing", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* wakeThenFinish(h);
    const before = (yield* outboxRows).length;
    yield* Ref.set(h.settings, { ...ON, enabled: false });
    yield* service.handleEvent(
      run("completed", "late", "assistant:jarvis:1", h.sent[0]!.messageId),
    );
    assert.lengthOf(yield* outboxRows, before);
    yield* Ref.set(h.settings, ON);
    h.answers.set("assistant:jarvis:1", "");
    yield* service.handleEvent(run("failed", "bad", "assistant:jarvis:1", h.sent[0]!.messageId));
    const rows = yield* outboxRows;
    assert.include(rows.at(-1)!.message.text, "I could not finish that");
    // A wake run with nothing to say and an unknown wake key are ignored.
    yield* service.handleEvent(
      run("completed", "empty", "assistant:jarvis:1", h.sent[0]!.messageId),
    );
    yield* service.handleEvent(
      run("completed", "unknown", "assistant:jarvis:1", "autonomy-wake:nope"),
    );
    assert.lengthOf(yield* outboxRows, rows.length);
  }).pipe(Effect.provide(h.layer));
});

it.effect("start follows the event streams and the sweep timer", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* service.start();
    yield* TestClock.adjust(2 * MIN);
  }).pipe(Effect.provide(h.layer));
});

const T0 = "1970-01-01T00:00:00.000Z";
const live = { type: "live", providerSessionId: "s1" };

/** A pending request as the projection holds it, plus what getRuntimeResponseContext returns. */
const pendingRequest = (
  h: ReturnType<typeof harness>,
  input: {
    id: string;
    threadId: string;
    kind?: string;
    responseCapability?: unknown;
    item?: Record<string, unknown>;
    createdAt?: string;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const kind = input.kind ?? "command";
    const request = {
      id: input.id,
      kind,
      status: "pending",
      responseCapability: input.responseCapability ?? live,
    };
    h.contexts.set(input.id, {
      request,
      item: input.item ?? {
        type: "approval_request",
        requestId: input.id,
        prompt: "vp test run",
        reason: "Run the tests",
      },
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES (${input.id}, ${input.threadId}, 'n1', ${kind}, 'pending', ${input.createdAt ?? T0}, '{}')`;
  });

const settleRequest = (h: ReturnType<typeof harness>, id: string, status = "resolved") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = ${status} WHERE runtime_request_id = ${id}`;
    const context = h.contexts.get(id);
    if (context !== undefined) {
      h.contexts.set(id, { ...context, request: { ...(context.request as object), status } });
    }
  });

const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly decision_id: string; readonly delivery_id: string }>`
    SELECT * FROM channel_cards`;
});

it.effect("a request its assistant's chat already carded is not carded a second time", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const decisions = yield* DecisionService.DecisionService;
    const sql = yield* SqlClient.SqlClient;
    yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
    h.shells.set("assistant:jarvis:1", { ...plain, title: "Jarvis" });
    yield* pendingRequest(h, { id: "jarvis", threadId: "assistant:jarvis:1" });
    const mirror = yield* decisions.request({
      fromThreadId: "assistant:jarvis:1" as never,
      projectId: plain.projectId as never,
      threadTitle: "Jarvis",
      clientRequestId: "approval:jarvis",
      title: "Jarvis wants to run a command",
      context: "",
      options: [
        { id: "accept", label: "Approve" },
        { id: "decline", label: "Deny" },
      ],
      approvalRequestId: "jarvis",
    });
    yield* sql`INSERT INTO channel_cards (decision_id, delivery_id) VALUES (${mirror.id}, 'reply-card')`;
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    assert.lengthOf(yield* outboxRows, 0);
    assert.deepEqual(
      (yield* decisions.list({})).map((decision) => decision.id),
      [mirror.id],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a waiting approval in any thread reaches Telegram once, after the grace, as a numbered card",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const decisions = yield* DecisionService.DecisionService;
      // Jarvis keeps the default: only replies when messaged. Telling the user needs no mode.
      yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
      h.shells.set("t1", { ...plain, providerInstanceId: "claudeAgent" });
      h.shells.set("deleg", { ...plain, title: "Child", delegatedFrom: { threadId: "t1" } });
      h.shells.set("sub", {
        ...plain,
        title: "Sub",
        lineage: { relationshipToParent: "subagent" },
      });
      h.shells.set("assistant:jarvis:1", { ...plain, title: "Jarvis" });
      yield* pendingRequest(h, { id: "plain", threadId: "t1" });
      yield* pendingRequest(h, { id: "child", threadId: "deleg" });
      yield* pendingRequest(h, { id: "subagent", threadId: "sub" });
      yield* pendingRequest(h, { id: "jarvis", threadId: "assistant:jarvis:1" });
      // A provider's own machinery never waits on the user.
      yield* pendingRequest(h, { id: "tool", threadId: "t1", kind: "dynamic_tool_call" });

      yield* TestClock.adjust(MIN / 2);
      yield* service.notifyWaiting;
      assert.lengthOf(yield* outboxRows, 0);

      yield* TestClock.adjust(MIN / 2);
      yield* service.notifyWaiting;
      yield* service.notifyWaiting;
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 4);
      const card = (threadId: string) =>
        rows.find((row) => row.message.text.endsWith(`/threads/env-1/${threadId}`))!.message;
      const first = card("t1");
      assert.deepEqual(first.destination, {
        kind: "telegram",
        connectionId: "telegram",
        chatId: "4242",
      });
      assert.equal(first.senderName, "T3 Code");
      assert.deepEqual(first.choices, [
        { label: "Approve", value: "accept" },
        { label: "Deny", value: "decline" },
      ]);
      assert.equal(
        first.text,
        [
          "Claude is waiting for you",
          "Claude wants to run a command",
          "Project: acme/app · Thread: Fix login",
          "```sh\nvp test run\n```\n\nReason: Run the tests",
          "Open in T3: https://app.t3.codes/threads/env-1/t1",
        ].join("\n\n"),
      );
      assert.include(card("assistant%3Ajarvis%3A1").text, "Jarvis is waiting for you");
      assert.include(card("deleg").text, "Thread: Child");
      // Each card is the one a number answers, and it answers the request itself.
      assert.lengthOf(yield* cards, 4);
      const mirrors = yield* decisions.list({});
      assert.sameMembers(
        mirrors.map((decision) => decision.approvalRequestId),
        ["plain", "child", "subagent", "jarvis"],
      );
      const plainDecision = mirrors.find((decision) => decision.approvalRequestId === "plain")!;
      yield* decisions.answer({ decisionId: plainDecision.id, optionId: "accept" });
      assert.deepEqual(
        h.dispatched.map((command) => [command["requestId"], command["decision"]]),
        [["plain", "accept"]],
      );
      // None of it is a model wake, so the daily wake limit is untouched.
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT 1 FROM autonomy_wakes`, 0);
      assert.lengthOf(h.sent, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a request answered within the grace is never told, and the pause switches stop it",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const decisions = yield* DecisionService.DecisionService;
      h.shells.set("t1", plain);
      yield* pendingRequest(h, { id: "quick", threadId: "t1" });
      yield* TestClock.adjust(MIN / 2);
      yield* settleRequest(h, "quick");
      yield* pendingRequest(h, { id: "later", threadId: "t1" });
      yield* Ref.set(h.settings, { ...ON, notifyWaiting: false });
      yield* TestClock.adjust(5 * MIN);
      yield* service.notifyWaiting;
      yield* Ref.set(h.settings, { ...ON, enabled: false });
      yield* service.notifyWaiting;
      assert.lengthOf(yield* outboxRows, 0);
      assert.lengthOf(yield* decisions.list({}), 0);
      // A longer grace is honored, and turning it back on tells what still waits.
      yield* Ref.set(h.settings, { ...ON, notifyWaitingAfterMinutes: 10 });
      yield* service.notifyWaiting;
      assert.lengthOf(yield* outboxRows, 0);
      yield* TestClock.adjust(5 * MIN);
      yield* service.notifyWaiting;
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.equal(rows[0]!.delivery_id.startsWith("needs-you:"), true);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("without Telegram the waiting request is only in Activity, answerable there", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const decisions = yield* DecisionService.DecisionService;
    yield* Ref.update(h.telegram, (value) => ({ ...value, enabled: false }));
    h.shells.set("t1", plain);
    yield* pendingRequest(h, { id: "r1", threadId: "t1" });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    assert.lengthOf(yield* outboxRows, 0);
    const [decision] = yield* decisions.list({});
    assert.equal(decision!.status, "open");
    assert.equal(decision!.approvalRequestId, "r1");
  }).pipe(Effect.provide(h.layer));
});

it.effect("what already waited before the first run is never told, what came after is", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    h.shells.set("t1", plain);
    yield* pendingRequest(h, { id: "old", threadId: "t1", createdAt: "1969-12-31T23:00:00.000Z" });
    yield* pendingRequest(h, { id: "new", threadId: "t1" });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const rows = yield* outboxRows;
    assert.deepEqual(
      rows.map((row) => row.delivery_id.startsWith("needs-you:")),
      [true],
    );
    const decisions = yield* DecisionService.DecisionService;
    assert.deepEqual(
      (yield* decisions.list({})).map((decision) => decision.approvalRequestId),
      ["new"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a baseline that could not be recorded at start never lets the old backlog through",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM autonomy_needs_you WHERE subject_key = 'baseline'`;
      h.shells.set("t1", plain);
      yield* pendingRequest(h, { id: "old", threadId: "t1" });
      yield* TestClock.adjust(MIN);
      yield* service.notifyWaiting;
      assert.lengthOf(yield* outboxRows, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a card the chat app refused or may not have shown is told again later", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const sql = yield* SqlClient.SqlClient;
    h.shells.set("t1", plain);
    yield* pendingRequest(h, { id: "r1", threadId: "t1" });
    yield* pendingRequest(h, { id: "r2", threadId: "t1" });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const [first, second] = yield* outboxRows;
    yield* sql`UPDATE channel_outbox SET state = 'failed' WHERE delivery_id = ${first!.delivery_id}`;
    yield* sql`UPDATE channel_outbox SET state = 'ambiguous' WHERE delivery_id = ${second!.delivery_id}`;
    yield* service.notifyWaiting;
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.state),
      ["failed", "ambiguous"],
    );
    yield* TestClock.adjust(31 * MIN);
    yield* service.notifyWaiting;
    assert.deepEqual(
      (yield* outboxRows).map((row) => row.state),
      ["pending", "pending"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a card waits for a chat that is on but not ready, and is told once it is", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* Ref.update(h.telegram, (value) => ({ ...value, allowedUserIds: [] }));
    h.shells.set("t1", plain);
    yield* pendingRequest(h, { id: "r1", threadId: "t1" });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    assert.lengthOf(yield* outboxRows, 0);
    yield* Ref.update(h.telegram, (value) => ({ ...value, allowedUserIds: ["111"] }));
    yield* service.notifyWaiting;
    yield* service.notifyWaiting;
    assert.lengthOf(yield* outboxRows, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "iMessage carries the card when Telegram is not set up and the user wrote from it",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const sql = yield* SqlClient.SqlClient;
      yield* Ref.update(h.telegram, (value) => ({ ...value, tokenConfigured: false }));
      yield* Ref.set(h.imessage, { enabled: true, selfHandles: ["me@example.com"] });
      const self = {
        kind: "imessage" as const,
        connectionId: "imessage",
        chatGuid: "iMessage;-;me@example.com",
      };
      const friend = { ...self, chatGuid: "iMessage;-;+15550000001" };
      for (const [key, actor, address] of [
        ["k1", "me@example.com", self],
        ["k2", "+15550000001", friend],
      ] as const) {
        yield* sql`
        INSERT INTO channel_inbox (connection_id, idempotency_key, payload_json, state)
        VALUES ('imessage', ${key}, ${JSON.stringify({ actor: { externalActorId: actor }, replyAddress: address })}, 'sent')`;
      }
      h.shells.set("t1", plain);
      yield* pendingRequest(h, { id: "r1", threadId: "t1" });
      yield* TestClock.adjust(MIN);
      yield* service.notifyWaiting;
      const [row] = yield* outboxRows;
      // The newest message came from someone else; only the user's own chat gets the card.
      assert.deepEqual(row!.message.destination, self);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("secrets in a waiting command never reach the chat", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    h.shells.set("t1", plain);
    yield* pendingRequest(h, {
      id: "r1",
      threadId: "t1",
      item: {
        type: "approval_request",
        requestId: "r1",
        prompt: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 gh pr merge",
      },
    });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const [row] = yield* outboxRows;
    assert.include(row!.message.text, "GITHUB_TOKEN=[redacted] gh pr merge");
    assert.notInclude(row!.message.text, "ghp_");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a secret at the edge of the clipped context is redacted before the cut", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    h.shells.set("t1", plain);
    yield* pendingRequest(h, {
      id: "r1",
      threadId: "t1",
      item: {
        type: "approval_request",
        requestId: "r1",
        prompt: `echo ${"a".repeat(1_180)} ghp_${"Z".repeat(32)}`,
      },
    });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const [row] = yield* outboxRows;
    assert.notInclude(row!.message.text, "ghp_");
    assert.notInclude(row!.message.text, "ZZZZ");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a command cut to fit the card cannot be approved from the chat", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const decisions = yield* DecisionService.DecisionService;
    h.shells.set("t1", plain);
    for (const [id, length] of [
      ["card", 2_000],
      ["decision", 5_000],
    ] as const) {
      yield* pendingRequest(h, {
        id,
        threadId: "t1",
        item: { type: "approval_request", requestId: id, prompt: `echo ${"a".repeat(length)}` },
      });
    }
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 2);
    for (const { message } of rows) {
      assert.isUndefined(message.choices);
      assert.include(message.text, "(cut short — open it in T3)");
      assert.include(message.text, "https://app.t3.codes/threads/env-1/t1");
    }
    assert.lengthOf(yield* cards, 0);
    // Cut at the decision's own limit, it is not an approval in Activity either.
    const cut = (yield* decisions.list({})).find((decision) =>
      decision.context.includes("a".repeat(4_000).slice(0, 3_900)),
    );
    assert.isUndefined(cut?.approvalRequestId);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a single-choice question offers its options; any other question informs and leaves when answered",
  () => {
    const h = harness("pt-BR");
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const decisions = yield* DecisionService.DecisionService;
      h.shells.set("t1", plain);
      const question = (id: string, multiSelect = false) => ({
        id: `q-${id}`,
        header: "Region",
        question: `Where should ${id} deploy?`,
        options: [
          { label: "Europe", description: "eu", value: "eu-west-1" },
          { label: "Brazil", description: "br" },
        ],
        multiSelect,
      });
      yield* pendingRequest(h, {
        id: "single",
        threadId: "t1",
        kind: "user_input",
        item: { type: "user_input_request", requestId: "single", questions: [question("single")] },
      });
      yield* pendingRequest(h, {
        id: "multi",
        threadId: "t1",
        kind: "user_input",
        item: {
          type: "user_input_request",
          requestId: "multi",
          questions: [question("multi", true)],
        },
      });
      yield* TestClock.adjust(MIN);
      yield* service.notifyWaiting;
      const rows = yield* outboxRows;
      const single = rows.find((row) => row.message.text.includes("single deploy"))!.message;
      assert.deepEqual(
        single.choices?.map((choice) => choice.label),
        ["Europe", "Brazil"],
      );
      assert.include(single.text, "T3 Code está esperando você");
      assert.include(single.text, "T3 Code tem uma pergunta para você");
      const multi = rows.find((row) => row.message.text.includes("multi deploy"))!.message;
      assert.isUndefined(multi.choices);
      assert.include(multi.text, "Responda no T3.");
      assert.lengthOf(yield* cards, 1);

      const answered = (yield* decisions.list({})).find(
        (decision) => decision.approvalRequestId === "single",
      )!;
      yield* decisions.answer({ decisionId: answered.id, optionId: "option:1" });
      assert.deepEqual(h.dispatched.at(-1)?.["answers"], { "q-single": "Brazil" });

      yield* settleRequest(h, "multi");
      yield* service.notifyWaiting;
      const notice = (yield* decisions.list({})).find((decision) => decision.notice === true)!;
      assert.equal(notice.status, "withdrawn");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("an open decision, Jarvis's own included, is carded once; notices are not", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const decisions = yield* DecisionService.DecisionService;
    yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
    h.shells.set("assistant:jarvis:1", { ...plain, title: "Jarvis" });
    const asked = yield* decisions.request({
      fromThreadId: "assistant:jarvis:1" as never,
      projectId: "p1" as never,
      threadTitle: "Jarvis",
      clientRequestId: "ask-1",
      title: "Renew the domain now?",
      context: "It expires Friday.",
      options: [
        { id: "yes", label: "Renew" },
        { id: "no", label: "Let it lapse" },
      ],
    });
    yield* decisions.request({
      fromThreadId: "assistant:jarvis:1" as never,
      projectId: "p1" as never,
      threadTitle: "Jarvis",
      clientRequestId: `${DecisionService.NOTICE_REQUEST_PREFIX}run-1`,
      title: "Jarvis: Run looks stuck",
      context: "",
      options: [{ id: "ok", label: "Got it" }],
    });
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    yield* service.notifyWaiting;
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 1);
    assert.include(rows[0]!.message.text, "Jarvis is waiting for you\n\nRenew the domain now?");
    assert.deepEqual(rows[0]!.message.choices, [
      { label: "Renew", value: "yes" },
      { label: "Let it lapse", value: "no" },
    ]);
    assert.deepEqual(yield* cards, [{ decision_id: asked.id, delivery_id: rows[0]!.delivery_id }]);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a group task paused for the user is told once, and its notice leaves when it resumes",
  () => {
    const h = harness("pt-BR");
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const decisions = yield* DecisionService.DecisionService;
      const sql = yield* SqlClient.SqlClient;
      yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY, "ana");
      yield* sql`
        INSERT INTO assistant_teams (team_id, name, member_ids_json, created_at, updated_at)
        VALUES ('team-1', 'Ops', '["ana"]', ${T0}, ${T0})`;
      const task = (id: string, reason: string) => sql`
        INSERT INTO assistant_group_tasks
          (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
           reason, request_id, created_at, updated_at)
        VALUES (${id}, 'team-1', ${id}, 'root', 'msg-1', 'ana', 'Ship the release notes',
          'paused', ${reason}, 'msg-1', ${T0}, ${T0})`;
      yield* task("limit", "handoff_limit");
      yield* task("stopped", "stopped");
      yield* TestClock.adjust(MIN);
      yield* service.notifyWaiting;
      yield* service.notifyWaiting;
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.isUndefined(rows[0]!.message.choices);
      assert.include(rows[0]!.message.text, "ana está esperando você");
      assert.include(rows[0]!.message.text, "Ops: Tarefa de grupo pausada");
      assert.include(rows[0]!.message.text, "Chegou ao limite de repasses.");
      const [notice] = yield* decisions.list({});
      assert.equal(notice!.status, "open");
      // The notice opens the conversation of the task's own request.
      assert.equal(notice!.fromThreadId, requestThreadId("ana", "team-1", "msg-1"));
      yield* sql`UPDATE assistant_group_tasks SET status = 'running', updated_at = 'later' WHERE task_id = 'limit'`;
      yield* service.notifyWaiting;
      assert.equal((yield* decisions.get(notice!.id)).status, "withdrawn");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a paused branch of a group request is told once, for its top task", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const sql = yield* SqlClient.SqlClient;
    yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY, "ana");
    yield* sql`
      INSERT INTO assistant_teams (team_id, name, member_ids_json, created_at, updated_at)
      VALUES ('team-1', 'Ops', '["ana"]', ${T0}, ${T0})`;
    const task = (id: string, parent: string | null) => sql`
      INSERT INTO assistant_group_tasks
        (task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction,
         status, reason, created_at, updated_at)
      VALUES (${id}, 'team-1', 'root', ${parent}, ${parent === null ? "root" : "subtask"}, 'msg-1',
        'ana', ${`Do ${id}`}, 'paused', 'handoff_limit', ${T0}, ${T0})`;
    yield* task("root", null);
    yield* task("child", "root");
    yield* task("grandchild", "child");
    yield* TestClock.adjust(MIN);
    yield* service.notifyWaiting;
    const rows = yield* outboxRows;
    assert.lengthOf(rows, 1);
    assert.include(rows[0]!.message.text, "Do root");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a message whose delivery could not be queued is not counted as sent", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    const sql = yield* SqlClient.SqlClient;
    yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
    const say = service.notifyUser({ assistantId: "jarvis", key: "k1", text: "Deploy done." });
    yield* sql`ALTER TABLE channel_outbox RENAME TO channel_outbox_away`;
    const failed = yield* Effect.exit(say);
    yield* sql`ALTER TABLE channel_outbox_away RENAME TO channel_outbox`;
    assert.isTrue(Exit.isFailure(failed));
    assert.equal((yield* say).status, "sent");
    assert.lengthOf(yield* outboxRows, 1);
  }).pipe(Effect.provide(h.layer));
});

const scheduledRun = (
  status: string,
  runId: string,
  taskId: string,
  threadId = "assistant:jarvis:1",
) => run(status, runId, threadId, `scheduled-task-message:${taskId}:123:schedule`);

const addScheduledTask = (taskId: string, teamId: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
        thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, last_run_status, run_count,
        assistant_team_id)
      VALUES (${taskId}, 'Renew the domain', 'Remind me', 1, '{}', 'p1', 'assistant:jarvis:1',
        '{}', '{}', 'full-access', 'default', 'agent', 'mcp', ${T0}, ${T0}, 'never', 0, ${teamId})`;
  });

it.effect(
  "an assistant's reminder reaches Telegram whatever its mode; a group routine does not",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
      yield* addScheduledTask("task:remind");
      yield* addScheduledTask("task:group", "team-1");
      h.answers.set("assistant:jarvis:1", "Time to renew acme.dev.");
      yield* service.handleEvent(scheduledRun("completed", "s1", "task:remind"));
      yield* service.handleEvent(scheduledRun("completed", "s1", "task:remind"));
      yield* service.handleEvent(scheduledRun("completed", "s2", "task:group"));
      yield* service.handleEvent(scheduledRun("cancelled", "s3", "task:remind"));
      yield* service.handleEvent(scheduledRun("completed", "s4", "task:remind", "t1"));
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.equal(rows[0]!.message.text, "Routine: Renew the domain\n\nTime to renew acme.dev.");
      assert.equal(rows[0]!.message.senderName, "Jarvis");
      yield* Ref.set(h.settings, { ...ON, enabled: false });
      yield* service.handleEvent(scheduledRun("completed", "s5", "task:remind"));
      assert.lengthOf(yield* outboxRows, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "an assistant's message to the user reaches Telegram and Activity once, within its own limit",
  () => {
    const h = harness("pt-BR");
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const decisions = yield* DecisionService.DecisionService;
      yield* addAssistant(DEFAULT_ASSISTANT_AUTONOMY);
      h.shells.set("t1", plain);
      yield* Ref.set(h.settings, { ...ON, maxUserMessagesPerDay: 2, maxWakesPerDay: 1 });
      const say = (key: string, text: string, threadId?: string) =>
        service.notifyUser({
          assistantId: "jarvis",
          key,
          text,
          ...(threadId === undefined ? {} : { threadId: threadId as never }),
        });
      const sent = yield* say("k1", "The deploy finished.", "t1");
      assert.deepEqual(sent, {
        status: "sent",
        channels: ["activity", "telegram"],
        remainingToday: 1,
      });
      assert.equal((yield* say("k1", "The deploy finished.", "t1")).status, "already_sent");
      const [row] = yield* outboxRows;
      assert.equal(row!.message.senderName, "Jarvis");
      assert.equal(
        row!.message.text,
        "The deploy finished.\n\nAbrir no T3: https://app.t3.codes/threads/env-1/t1",
      );
      const [notice] = yield* decisions.list({});
      assert.isTrue(notice!.notice);
      assert.equal(notice!.title, "Jarvis");

      const refused = <A>(effect: Effect.Effect<A, AutonomyError>) =>
        Effect.flip(effect).pipe(Effect.map((error) => error.message));
      assert.include(
        yield* refused(say("k2", "token: ghp_abcdefghijklmnopqrstuvwxyz0123")),
        "secret",
      );
      assert.include(yield* refused(say("k3", "  ")), "text");
      assert.include(yield* refused(say("k3b", "x".repeat(2_001))), "2000 characters");
      assert.include(
        yield* refused(service.notifyUser({ assistantId: "ghost", key: "k3c", text: "Hi." })),
        "active assistant",
      );
      assert.include(yield* refused(say("k4", "x", "missing")), "thread");
      yield* say("k5", "Second.");
      assert.include(yield* refused(say("k6", "Third.")), "2 messages today");

      // Messages and wakes keep separate counts.
      h.shells.set("t2", plain);
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE assistants SET autonomy_json = ${JSON.stringify(awake)}`,
      );
      yield* service.handleEvent(run("failed", "r1", "t2"));
      assert.lengthOf(h.sent, 1);

      yield* TestClock.adjust(24 * 60 * MIN + 1);
      assert.equal((yield* say("k7", "Next day.")).status, "sent");
      yield* Ref.set(h.settings, { ...ON, enabled: false });
      assert.include(yield* refused(say("k8", "Paused.")), "paused");
    }).pipe(Effect.provide(h.layer));
  },
);
