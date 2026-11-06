import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ASSISTANT_STANDUP_PROMPT_HEAD,
  DEFAULT_AUTONOMY_SETTINGS,
  type AssistantAutonomy,
  type AutonomySettings,
  type KanbanStreamItem,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { AssistantSpend } from "../assistants/AssistantSpend.ts";
import { ChannelLanguage } from "../channels/ChannelLanguage.ts";
import * as ChannelOutbox from "../channels/ChannelOutbox.ts";
import { outboxRows } from "../channels/channelBridgeTestSupport.ts";
import * as ChannelTransport from "../channels/ChannelTransport.ts";
import * as TelegramChannelSettings from "../channels/telegram/TelegramChannelSettings.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as KanbanService from "../kanban/KanbanService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Autonomy from "./AutonomyService.ts";

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
  lineage: { relationshipToParent: string | null };
  sideChatOf?: unknown;
  delegatedFrom?: unknown;
};
// Real shells omit `sideChatOf` unless the thread is a side chat.
const plain: Shell = {
  title: "Fix login",
  projectId: "p1",
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
              turnItems: [],
            } as never),
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
  return { layer, settings, shells, sent, refusal, sendFails, telegram, answers };
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

it.effect("a reply-only assistant never wakes, even with a matching watch", () => {
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
    yield* service.handleEvent(run("completed", "r2"));
    assert.lengthOf(h.sent, 0);
  }).pipe(Effect.provide(h.layer));
});

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

it.effect(
  "a leader's standup run reaches the user unless autonomy is paused; other schedules do not",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const service = yield* Autonomy.AutonomyService;
      const sql = yield* SqlClient.SqlClient;
      yield* addAssistant({ ...awake, mode: "reply-only" });
      const task = (id: string, prompt: string) =>
        sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, last_run_status, run_count
        ) VALUES (${id}, 'Renamed', ${prompt}, 1, '{}', 'p1', 'assistant:jarvis:1', '{}', '{}',
          'full-access', 'default', 'system', 'server', '2026-01-01', '2026-01-01', 'never', 0)`;
      yield* task("standup:1", `${ASSISTANT_STANDUP_PROMPT_HEAD}\nAsk everyone.`);
      yield* task("other:1", "Check the weather.");
      h.answers.set("assistant:jarvis:1", "Eng shipped, nothing blocked.");
      const finish = (id: string, message: string) =>
        service.handleEvent(run("completed", id, "assistant:jarvis:1", message));

      // The pause switch silences the standup too.
      yield* Ref.set(h.settings, { ...ON, enabled: false });
      yield* finish("r0", "scheduled-task-message:standup:1:1600:schedule");
      assert.lengthOf(yield* outboxRows, 0);
      yield* Ref.set(h.settings, ON);

      yield* finish("r1", "scheduled-task-message:other:1:1700:schedule");
      assert.lengthOf(yield* outboxRows, 0);
      yield* finish("r2", "scheduled-task-message:standup:1:1700:schedule");
      const rows = yield* outboxRows;
      assert.lengthOf(rows, 1);
      assert.include(rows[0]!.message.text, "Daily standup");
      assert.include(rows[0]!.message.text, "Eng shipped");
      const decisions = yield* DecisionService.DecisionService;
      assert.lengthOf(yield* decisions.list({}), 1);
      // A replay of the same run delivers once.
      yield* finish("r2", "scheduled-task-message:standup:1:1700:schedule");
      assert.lengthOf(yield* outboxRows, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("start follows the event streams and the sweep timer", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* Autonomy.AutonomyService;
    yield* service.start();
    yield* TestClock.adjust(2 * MIN);
  }).pipe(Effect.provide(h.layer));
});
