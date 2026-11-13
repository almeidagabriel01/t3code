import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_ASSISTANT_AUTONOMY,
  DEFAULT_AUTONOMY_SETTINGS,
  type AssistantAutonomy,
  type KanbanCard,
  type KanbanError,
  type KanbanCardId,
  type KanbanStreamItem,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import { AssistantSpend } from "../assistants/AssistantSpend.ts";
import * as AutonomyService from "../autonomy/AutonomyService.ts";
import * as HeavyQueueNotices from "../heavyQueue/HeavyQueueNotices.ts";
import * as KanbanService from "../kanban/KanbanService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { HeavyEventRecord } from "../heavyQueue/heavyNotices.ts";
import * as Detector from "./ProblemDetector.ts";
import type { ProblemReport } from "./problemRules.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

interface Settings {
  readonly autonomy: typeof DEFAULT_AUTONOMY_SETTINGS;
  readonly detectProblems: boolean;
  readonly projectSettingsOverrides: Record<string, { detectProblems?: boolean }>;
}

const harness = () => {
  const settings = Ref.makeUnsafe<Settings>({
    autonomy: { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true },
    detectProblems: true,
    projectSettingsOverrides: {},
  });
  const plain = { lineage: { relationshipToParent: null } };
  const shells = new Map<string, Record<string, unknown>>([
    ["t1", { ...plain, projectId: "p1", title: "Fix login" }],
    ["t2", { ...plain, projectId: "p2", title: "Other repo" }],
  ]);
  const runErrors = new Map<string, string>();
  const sent: Array<{ threadId: string; text: string; messageId: string }> = [];
  const told: Array<{ key: string; text: string; threadId: string | null }> = [];
  const scratchFails = { current: false };
  const layer = Detector.layer.pipe(
    Layer.provideMerge(KanbanService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.sync(() => {
              sent.push({ threadId: input.threadId, text: input.text, messageId: input.messageId });
              return {} as never;
            }),
          getThreadRecords: (threadId) =>
            Effect.succeed({
              turnItems: runErrors.has(threadId)
                ? [{ type: "error", failure: { message: runErrors.get(threadId) } }]
                : [],
            } as never),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          ensureScratchProject: Effect.suspend(() =>
            scratchFails.current
              ? Effect.die("no scratch")
              : Effect.succeed({ projectId: "scratch" as ProjectId }),
          ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) => Effect.succeedSome({ title: `Project ${projectId}` } as never),
          listShells: () => Effect.succeed([{ id: "p1", workspaceRoot: "/repo/one" }] as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed([{ threadId: "tw" as ThreadId, worktreePath: "/wt/feature" }]),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Ref.get(settings).pipe(Effect.map((value) => value as never)),
        }),
        Layer.mock(AssistantSpend)({ budgetRefusal: () => Effect.succeedNone }),
        Layer.mock(HeavyQueueNotices.HeavyQueueNotices)({ records: Stream.empty }),
        Layer.mock(AutonomyService.AutonomyService)({
          tellUser: (input) => Effect.sync(() => void told.push(input)),
        }),
      ),
    ),
  );
  return { layer, settings, sent, told, scratchFails, shells, runErrors };
};

const addAssistant = (input: {
  id: string;
  scope?: "all" | "project";
  projectIds?: ReadonlyArray<string>;
  autonomy?: AssistantAutonomy;
  toolAccess?: string;
  createdAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectIds = input.projectIds ?? [];
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, project_ids_json, scope, tool_access, thread_id,
         autonomy_json, created_at, updated_at)
      VALUES (${input.id}, ${input.id}, ${input.id.toUpperCase()}, ${projectIds[0] ?? "home"},
        ${JSON.stringify(projectIds)}, ${input.scope ?? "all"}, ${input.toolAccess ?? "full"},
        ${`assistant:${input.id}:1`}, ${JSON.stringify(input.autonomy ?? DEFAULT_ASSISTANT_AUTONOMY)},
        ${input.createdAt ?? "2026-01-01"}, '2026-01-01')`;
  });

let keys = 0;
const failure = (overrides: Partial<ProblemReport> = {}): ProblemReport => ({
  key: `occurrence-${++keys}`,
  source: "runner",
  projectId: "p1",
  threadId: null,
  subject: null,
  command: "pnpm test",
  error: "zsh:1: command not found: pnpm",
  where: "Linux",
  at: 0,
  ...overrides,
});

const allCards = Effect.gen(function* () {
  const kanban = yield* KanbanService.KanbanService;
  const head = yield* Stream.runHead(kanban.subscribe());
  const item = Option.getOrThrow(head) as Extract<KanbanStreamItem, { kind: "snapshot" }>;
  return item.boards.flatMap((board) =>
    board.cards.map((card) => ({ ...card, projectId: board.projectId as string })),
  );
});

const skips = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly event_key: string; readonly skip_reason: string | null }>`
    SELECT event_key, skip_reason FROM problem_occurrences ORDER BY rowid`;
});

const doneColumn = (card: KanbanCard) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly column_id: string }>`
      SELECT column_id FROM kanban_columns WHERE board_id = ${card.boardId} AND role = 'done'`;
    return rows[0]!.column_id;
  });

const run = <A, E>(
  h: ReturnType<typeof harness>,
  body: Effect.Effect<
    A,
    E,
    Detector.ProblemDetector | KanbanService.KanbanService | SqlClient.SqlClient
  >,
) => body.pipe(Effect.provide(h.layer));

describe("one card per cause (PRO-01..PRO-07)", () => {
  it.effect(
    "files one card with evidence and wakes the owner once, however often it replays",
    () => {
      const h = harness();
      return run(
        h,
        Effect.gen(function* () {
          const detector = yield* Detector.ProblemDetector;
          yield* addAssistant({ id: "jarvis" });
          const first = failure({ threadId: "t1", projectId: null, key: "runner:r1" });
          // PRO-03: a restart or retry delivers the same occurrence again.
          for (let i = 0; i < 3; i++) {
            yield* detector.report(first);
            yield* detector.tick;
          }
          const cards = yield* allCards;
          assert.lengthOf(cards, 1);
          const card = cards[0]!;
          assert.equal(card.projectId, "p1");
          assert.equal(card.title, "Environment: zsh:1: command not found: pnpm");
          assert.deepEqual(card.problem, {
            kind: "environment",
            count: 1,
            ownerName: "JARVIS",
            previousCardNumber: null,
            ignored: false,
          });
          for (const label of ["Runner", "`pnpm test`", "Command not found", "Linux", "Fix login"])
            assert.include(card.description, label);
          assert.lengthOf(h.sent, 1);
          assert.equal(h.sent[0]!.threadId, "assistant:jarvis:1");
          assert.include(
            h.sent[0]!.text,
            `Problem in Project p1: zsh:1: command not found: pnpm. Card #${card.number}.`,
          );
          assert.match(h.sent[0]!.messageId, /^autonomy-wake:problem:jarvis:/);
        }),
      );
    },
  );

  it.effect("counts repeats on the open card and comments at most once an hour", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const kanban = yield* KanbanService.KanbanService;
        yield* addAssistant({ id: "jarvis" });
        // Different runs, paths and numbers: the same cause.
        const errors = [
          "spawn /tmp/a1/bin/tsc ENOENT",
          "spawn /tmp/b22/bin/tsc ENOENT",
          "spawn /tmp/c333/bin/tsc ENOENT",
        ];
        for (const error of errors) yield* detector.report(failure({ error }));
        yield* detector.tick;
        yield* TestClock.adjust(HOUR + MIN);
        yield* detector.report(failure({ error: "spawn /tmp/d/bin/tsc ENOENT", at: HOUR + MIN }));
        yield* detector.tick;
        const cards = yield* allCards;
        assert.lengthOf(cards, 1);
        assert.equal(cards[0]!.problem?.count, 4);
        const detail = yield* kanban.getCard({ cardId: cards[0]!.id });
        const comments = detail.activity
          .filter((event) => event.kind === "comment")
          .map((event) => (event.payload as { body: string }).body);
        assert.deepEqual(comments, ["Seen 2 times", "Seen 4 times"]);
        assert.lengthOf(h.sent, 1);
      }),
    );
  });

  const closers: ReadonlyArray<
    readonly [
      string,
      (
        card: KanbanCard,
      ) => Effect.Effect<
        unknown,
        KanbanError | SqlError,
        KanbanService.KanbanService | SqlClient.SqlClient
      >,
    ]
  > = [
    [
      "done",
      (card) =>
        Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.cardMove({
            commandId: CommandId.make(`move-${card.id}`),
            cardId: card.id,
            columnId: (yield* doneColumn(card)) as never,
          });
        }),
    ],
    [
      "archived",
      (card) =>
        Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.cardArchive({
            commandId: CommandId.make(`archive-${card.id}`),
            cardId: card.id,
          });
        }),
    ],
    [
      "deleted",
      (card) =>
        Effect.gen(function* () {
          const kanban = yield* KanbanService.KanbanService;
          yield* kanban.cardDelete({
            commandId: CommandId.make(`delete-${card.id}`),
            cardId: card.id,
          });
        }),
    ],
  ];
  it.effect.each(closers)(
    "files a new card that links the old one after it is %s (PRO-06)",
    ([_state, close]) => {
      const h = harness();
      return run(
        h,
        Effect.gen(function* () {
          const detector = yield* Detector.ProblemDetector;
          yield* addAssistant({ id: "jarvis" });
          yield* detector.report(failure());
          yield* detector.tick;
          const first = (yield* allCards)[0]!;
          yield* close(first);
          yield* detector.report(failure());
          yield* detector.tick;
          const open = (yield* allCards).filter((card) => card.id !== first.id);
          const latest = open.find((card) => card.problem?.previousCardNumber === first.number);
          assert.isDefined(latest);
          assert.equal(latest!.problem?.count, 1);
          assert.lengthOf(h.sent, 2);
        }),
      );
    },
  );

  it.effect("records a skip with its reason and keeps going (PRO-07)", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const sql = yield* SqlClient.SqlClient;
        yield* addAssistant({ id: "jarvis" });
        h.scratchFails.current = true;
        yield* detector.report(failure({ projectId: null, key: "no-project" }));
        h.scratchFails.current = false;
        yield* sql`
          INSERT INTO problem_occurrences (event_key, fingerprint, project_id, kind, reason, report_json, occurred_at)
          VALUES ('malformed', 'fp', 'p1', 'environment', 'network', '{not json', '1970-01-01T00:00:00.000Z')`;
        yield* detector.report(failure({ key: "good" }));
        yield* detector.tick;
        const reasons = Object.fromEntries(
          (yield* skips).map((row) => [row.event_key, row.skip_reason]),
        );
        assert.deepEqual(reasons, { "no-project": "unresolved", malformed: "failed", good: null });
        assert.lengthOf(yield* allCards, 1);
      }),
    );
  });

  it.effect("a card only carries evidence from its own project (PRO-05)", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({ id: "jarvis" });
        yield* detector.report(failure({ projectId: null, threadId: "t1", where: "Linux" }));
        yield* detector.report(
          failure({ projectId: null, threadId: "t2", where: "secret-host-of-p2" }),
        );
        yield* detector.tick;
        const cards = yield* allCards;
        assert.lengthOf(cards, 2);
        const p1 = cards.find((card) => card.projectId === "p1")!;
        assert.notInclude(p1.description, "secret-host-of-p2");
        assert.notInclude(p1.description, "Other repo");
        assert.equal(p1.problem?.count, 1);
      }),
    );
  });

  it.effect("an event whose project is unknown goes to the No-project board", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* detector.report(failure({ projectId: null, source: "link", error: "fetch failed" }));
        yield* detector.tick;
        assert.deepEqual(
          (yield* allCards).map((card) => [card.projectId, card.title]),
          [["scratch", "Connection: fetch failed"]],
        );
      }),
    );
  });
});

describe("repeat rule (PRO-31)", () => {
  it.effect("a plain failure becomes a problem the third time in 24 hours", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const plain = { error: "Exit code 1", where: "this Mac" };
        yield* detector.report(failure({ ...plain, at: 0 }));
        yield* detector.report(failure({ ...plain, at: 3 * HOUR }));
        yield* detector.tick;
        assert.lengthOf(yield* allCards, 0);
        // Outside the window the first one no longer counts.
        yield* detector.report(failure({ ...plain, at: 25 * HOUR }));
        yield* detector.tick;
        assert.lengthOf(yield* allCards, 0);
        yield* detector.report(failure({ ...plain, at: 26 * HOUR }));
        yield* detector.tick;
        const cards = yield* allCards;
        assert.deepEqual(
          cards.map((card) => [card.title, card.problem?.kind]),
          [["Repeated failure: Exit code 1", "repeated"]],
        );
        assert.include(cards[0]!.description, "Seen 3 times in 24 hours");
        // Later plain occurrences count on the open card without waiting for three more.
        yield* detector.report(failure({ ...plain, at: 27 * HOUR }));
        yield* detector.tick;
        assert.equal((yield* allCards)[0]!.problem?.count, 2);
      }),
    );
  });
});

describe("owner (PRO-10..PRO-13)", () => {
  it.effect("the project assistant owns it over Jarvis, and the card says so", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({ id: "jarvis" });
        yield* addAssistant({ id: "ops", scope: "project", projectIds: ["p1"] });
        yield* detector.report(failure());
        yield* detector.tick;
        assert.equal((yield* allCards)[0]!.problem?.ownerName, "OPS");
        assert.deepEqual(
          h.sent.map((wake) => wake.threadId),
          ["assistant:ops:1"],
        );
      }),
    );
  });

  it.effect("with no assistant for the project the card is filed and the user is told", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({ id: "ops", scope: "project", projectIds: ["p9"] });
        yield* detector.report(failure({ threadId: "t1", projectId: null }));
        yield* detector.report(failure({ threadId: "t1", projectId: null, error: "ENOSPC" }));
        yield* detector.tick;
        const cards = yield* allCards;
        assert.lengthOf(cards, 2);
        assert.isTrue(cards.every((card) => card.problem?.ownerName === null));
        assert.deepEqual(
          h.told.map((notice) => [notice.text, notice.threadId]),
          [["No assistant can work on Project p1. Give one access in Assistants.", "t1"]],
        );
        assert.lengthOf(h.sent, 0);
      }),
    );
  });

  it.effect("when the owner is archived its open case moves to the next owner", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const sql = yield* SqlClient.SqlClient;
        yield* addAssistant({ id: "jarvis" });
        yield* addAssistant({ id: "ops", scope: "project", projectIds: ["p1"] });
        yield* detector.report(failure());
        yield* detector.tick;
        yield* sql`UPDATE assistants SET archived_at = '2026-02-01' WHERE assistant_id = 'ops'`;
        yield* detector.tick;
        assert.equal((yield* allCards)[0]!.problem?.ownerName, "JARVIS");
        assert.deepEqual(
          h.sent.map((wake) => wake.threadId),
          ["assistant:ops:1", "assistant:jarvis:1"],
        );
        assert.include(h.sent[1]!.text, "It moved to you");
        // Nothing changes on the next tick.
        yield* detector.tick;
        assert.lengthOf(h.sent, 2);
      }),
    );
  });

  it.effect("the wake states the owner's level; a read-only owner only tells (PRO-21..25)", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({
          id: "jarvis",
          toolAccess: "read-only",
          autonomy: { ...DEFAULT_ASSISTANT_AUTONOMY, onProblem: "fix-small" },
        });
        yield* addAssistant({
          id: "ops",
          scope: "project",
          projectIds: ["p2"],
          autonomy: { ...DEFAULT_ASSISTANT_AUTONOMY, onProblem: "fix-small" },
        });
        yield* detector.report(failure({ projectId: "p1" }));
        yield* detector.report(failure({ projectId: "p2" }));
        yield* detector.tick;
        const byOwner = Object.fromEntries(h.sent.map((wake) => [wake.threadId, wake.text]));
        assert.include(byOwner["assistant:jarvis:1"], 'Your level is "Tell me"');
        assert.include(byOwner["assistant:ops:1"], 'Your level is "Fix small things"');
      }),
    );
  });
});

describe("wakes (PRO-20, edge cases)", () => {
  it.effect("a burst and a cause spanning projects make one wake per owner", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({ id: "jarvis" });
        for (let i = 0; i < 5; i++) yield* detector.report(failure({ projectId: "p1" }));
        yield* detector.report(failure({ projectId: "p2" }));
        yield* detector.tick;
        const cards = yield* allCards;
        assert.lengthOf(cards, 2);
        assert.lengthOf(h.sent, 1);
        assert.include(h.sent[0]!.text, "found 2 problems");
        assert.include(h.sent[0]!.text, "Problem in Project p1");
        assert.include(h.sent[0]!.text, "Problem in Project p2");
        assert.equal(cards.find((card) => card.projectId === "p1")!.problem?.count, 5);
      }),
    );
  });

  it.effect("while autonomy is paused the card is filed and the wake waits for the resume", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const kanban = yield* KanbanService.KanbanService;
        yield* addAssistant({ id: "jarvis" });
        yield* Ref.update(h.settings, (s) => ({
          ...s,
          autonomy: { ...s.autonomy, enabled: false },
        }));
        yield* detector.report(failure({ projectId: "p1" }));
        yield* detector.report(failure({ projectId: "p2" }));
        yield* detector.report(failure({ projectId: "p1", error: "ENOSPC" }));
        yield* detector.tick;
        const cards = yield* allCards;
        assert.lengthOf(cards, 3);
        assert.lengthOf(h.sent, 0);
        const closed = cards.find((card) => card.projectId === "p2")!;
        yield* kanban.cardArchive({ commandId: CommandId.make("archive-p2"), cardId: closed.id });
        yield* Ref.update(h.settings, (s) => ({
          ...s,
          autonomy: { ...s.autonomy, enabled: true },
        }));
        yield* detector.tick;
        assert.lengthOf(h.sent, 1);
        assert.include(h.sent[0]!.text, "found 2 problems");
        assert.notInclude(h.sent[0]!.text, "Project p2");
      }),
    );
  });

  it.effect("at the owner's daily message limit the card is filed and the wake is held", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const sql = yield* SqlClient.SqlClient;
        yield* addAssistant({ id: "jarvis" });
        for (let i = 0; i < DEFAULT_AUTONOMY_SETTINGS.maxUserMessagesPerDay; i++) {
          yield* sql`
            INSERT INTO autonomy_wakes (wake_key, assistant_id, watched_thread_id, source, label, created_at)
            VALUES (${`notify:${i}`}, 'jarvis', 'x', 'notify', 'message', '1970-01-01T00:00:00.000Z')`;
        }
        yield* detector.report(failure());
        yield* detector.tick;
        assert.lengthOf(yield* allCards, 1);
        assert.lengthOf(h.sent, 0);
        yield* TestClock.adjust(25 * HOUR);
        yield* detector.tick;
        assert.lengthOf(h.sent, 1);
      }),
    );
  });
});

describe("ways out (PRO-40, PRO-41)", () => {
  it.effect("ignoring a cause stops counting and waking until the user stops ignoring it", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* addAssistant({ id: "jarvis" });
        yield* Ref.update(h.settings, (s) => ({
          ...s,
          autonomy: { ...s.autonomy, enabled: false },
        }));
        yield* detector.report(failure());
        yield* detector.tick;
        const card = (yield* allCards)[0]!;
        yield* detector.setIgnored({
          commandId: CommandId.make("ignore"),
          cardId: card.id,
          ignored: true,
        });
        assert.isTrue((yield* allCards)[0]!.problem?.ignored);
        yield* Ref.update(h.settings, (s) => ({
          ...s,
          autonomy: { ...s.autonomy, enabled: true },
        }));
        yield* detector.report(failure({ key: "while-ignored" }));
        yield* detector.tick;
        assert.lengthOf(h.sent, 0);
        assert.equal((yield* allCards)[0]!.problem?.count, 1);
        assert.equal(
          (yield* skips).find((row) => row.event_key === "while-ignored")?.skip_reason,
          "ignored",
        );
        yield* detector.setIgnored({
          commandId: CommandId.make("unignore"),
          cardId: card.id,
          ignored: false,
        });
        yield* detector.report(failure());
        yield* detector.tick;
        assert.deepEqual((yield* allCards)[0]!.problem, {
          kind: "environment",
          count: 2,
          ownerName: "JARVIS",
          previousCardNumber: null,
          ignored: false,
        });
      }),
    );
  });

  it.effect("refuses to ignore a card that is not a problem card", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const error = yield* detector
          .setIgnored({
            commandId: CommandId.make("x"),
            cardId: "nope" as KanbanCardId,
            ignored: true,
          })
          .pipe(Effect.flip);
        assert.equal(error.kind, "invalid");
      }),
    );
  });

  const switches: ReadonlyArray<readonly [string, Partial<Settings>]> = [
    ["globally", { detectProblems: false }],
    ["for the project", { projectSettingsOverrides: { p1: { detectProblems: false } } }],
  ];
  it.effect.each(switches)("files nothing while detection is off %s", ([_where, patch]) => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        yield* Ref.update(h.settings, (s) => ({ ...s, ...patch }));
        yield* detector.report(failure({ key: "off" }));
        yield* detector.tick;
        assert.lengthOf(yield* allCards, 0);
        assert.equal((yield* skips)[0]?.skip_reason, "detection_off");
      }),
    );
  });
});

const domain = (type: string, threadId: string, payload: Record<string, unknown>) =>
  ({ type, threadId, payload }) as unknown as OrchestrationV2DomainEvent;
const failedRun = (id: string, threadId: string, extra: Record<string, unknown> = {}) =>
  domain("run.updated", threadId, {
    id,
    threadId,
    status: "failed",
    userMessageId: "m1",
    providerInstanceId: "claude",
    ...extra,
  });
const record = (overrides: Record<string, unknown>) =>
  ({
    id: "rec-1",
    at: 0,
    kind: "ended",
    code: 127,
    job: { id: "job-1", name: "pnpm test", threadId: null, runner: "linux" },
    ...overrides,
  }) as unknown as HeavyEventRecord;

describe("sources (PRO-30, PRO-32)", () => {
  it.effect(
    "a failed run files a card; replays, interrupts, own loops and assistant tasks file nothing",
    () => {
      const h = harness();
      return run(
        h,
        Effect.gen(function* () {
          const detector = yield* Detector.ProblemDetector;
          const plain = { lineage: { relationshipToParent: null } };
          h.shells.set("assistant:jarvis:1", { ...plain, projectId: "p1", title: "Jarvis" });
          h.shells.set("sub", {
            lineage: { relationshipToParent: "subagent" },
            projectId: "p1",
            title: "s",
          });
          h.shells.set("side", { ...plain, sideChatOf: "t1", projectId: "p1", title: "side" });
          h.shells.set("child", {
            ...plain,
            delegatedFrom: { threadId: "t1" },
            projectId: "p1",
            title: "c",
          });
          h.shells.set("task", { ...plain, projectId: "p1", title: "Jarvis's task" });
          yield* (yield* SqlClient.SqlClient)`
          INSERT INTO assistant_tasks (thread_id, assistant_id, project_id, title, created_at)
          VALUES ('task', 'jarvis', 'p1', 'Jarvis''s task', '2026-01-01T00:00:00.000Z')`;
          h.runErrors.set("task", "Tests failed");
          h.runErrors.set("t1", "API Error: 529 Overloaded");
          for (const event of [
            failedRun("r9", "task"),
            failedRun("r1", "t1"),
            failedRun("r1", "t1"),
            failedRun("r2", "t1", { status: "interrupted" }),
            failedRun("r3", "t1", { status: "cancelled" }),
            failedRun("r4", "assistant:jarvis:1"),
            failedRun("r5", "sub"),
            failedRun("r6", "side"),
            failedRun("r7", "child"),
            failedRun("r8", "missing"),
          ])
            yield* detector.handleEvent(event);
          yield* detector.tick;
          const cards = yield* allCards;
          assert.deepEqual(
            cards.map((card) => card.title),
            ["Provider: API Error: 529 Overloaded"],
          );
          assert.include(cards[0]!.description, "Agent run");
          assert.deepEqual(
            (yield* skips).map((row) => row.event_key),
            ["run:r1"],
          );
        }),
      );
    },
  );

  it.effect("provider sessions in error, PR checks turning failing, Runner records", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const session = {
          id: "s1",
          status: "error",
          providerInstanceId: "codex",
          lastError: "spawn codex ENOENT",
        };
        // The same error repeats on every update while the session stays broken.
        for (let i = 0; i < 3; i++)
          yield* detector.handleEvent(domain("provider-session.updated", "t1", session));
        yield* detector.handleEvent(
          domain("provider-session.updated", "t1", { ...session, status: "ready" }),
        );
        const pr = (state: string, updatedAt: string) =>
          domain("thread.pull-request-link-updated", "t2", {
            number: 7,
            url: "https://example.test/pr/7",
            snapshot: { checksState: state, updatedAt },
          });
        for (const event of [
          pr("failing", "a"),
          pr("failing", "b"),
          pr("passing", "c"),
          pr("failing", "d"),
        ])
          yield* detector.handleEvent(event);
        yield* detector.handleRecord(
          record({ id: "rec-1", job: { id: "j", name: "x", threadId: null, runner: "mac" } }),
        );
        // Linux environment failures arrive as t3-fault; the plain records only feed the toasts.
        yield* detector.handleRecord(record({ id: "rec-0" }));
        yield* detector.handleRecord(record({ id: "rec-2", code: 1, phase: "syncing" }));
        yield* detector.handleRecord(record({ id: "rec-3", kind: "linux-lost" }));
        h.shells.set("tw", {
          lineage: { relationshipToParent: null },
          projectId: "p3",
          title: "w",
        });
        const fault = (id: string, fields: Record<string, unknown>) =>
          record({
            id,
            kind: "t3-fault",
            cause: "command-not-found:vp",
            reason: "command-not-found",
            command: "vp test run",
            error: "vp: command not found",
            projectFolder: "/wt/feature/apps/web",
            ...fields,
          });
        yield* detector.handleRecord(fault("rec-7", {}));
        yield* detector.handleRecord(
          fault("rec-8", { command: "vp lint", error: "zsh: command not found: vp" }),
        );
        yield* detector.handleRecord(
          fault("rec-9", {
            cause: "linux-sync:rsync-timeout",
            reason: "linux-sync",
            error: "rsync timed out",
            projectFolder: "/repo/one/src",
          }),
        );
        // A plain failure of a thread's own job, a cancel, and a thread of another server.
        yield* detector.handleRecord(
          record({
            id: "rec-4",
            code: 1,
            job: { id: "j", name: "x", threadId: "t1", runner: "mac" },
          }),
        );
        yield* detector.handleRecord(record({ id: "rec-5", kind: "deadline" }));
        yield* detector.handleRecord(
          record({
            id: "rec-6",
            job: { id: "j", name: "x", threadId: "elsewhere", runner: "mac" },
          }),
        );
        yield* detector.tick;
        const cards = yield* allCards;
        const byTitle = Object.fromEntries(cards.map((card) => [card.title, card]));
        assert.sameMembers(Object.keys(byTitle), [
          "Environment: spawn codex ENOENT",
          "CI: Checks failing on PR #7",
          "Environment: Exit code 127",
          "Environment: vp: command not found",
          "Environment: rsync timed out",
        ]);
        assert.equal(byTitle["CI: Checks failing on PR #7"]!.problem?.count, 2);
        assert.equal(byTitle["CI: Checks failing on PR #7"]!.projectId, "p2");
        const vp = byTitle["Environment: vp: command not found"]!;
        assert.deepEqual([vp.projectId, vp.problem?.count], ["p3", 2]);
        assert.include(vp.description, "vp test run");
        const sync = byTitle["Environment: rsync timed out"]!;
        assert.equal(sync.projectId, "p1");
        assert.include(sync.description, "Linux sync failed");
        assert.equal(byTitle["Environment: spawn codex ENOENT"]!.problem?.count, 1);
      }),
    );
  });

  it.effect("polls failed schedules and unreachable links once per occurrence", () => {
    const h = harness();
    return run(
      h,
      Effect.gen(function* () {
        const detector = yield* Detector.ProblemDetector;
        const sql = yield* SqlClient.SqlClient;
        const at = "1970-01-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
            thread_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
            created_by, creation_source, created_at, updated_at, last_run_at, last_run_status,
            last_run_error, run_count, assistant_team_id)
          VALUES
            ('task-1', 'Nightly report', 'p', 1, '{}', 'p1', NULL, '{}', '{}', 'full-access', 'default',
              'user', 'user', ${at}, ${at}, ${at}, 'failed', 'Project folder is missing', 1, NULL),
            ('task-2', 'Own routine', 'p', 1, '{}', 'p1', 'assistant:jarvis:1', '{}', '{}', 'full-access',
              'default', 'user', 'user', ${at}, ${at}, ${at}, 'failed', 'x', 1, NULL),
            ('task-3', 'Fine', 'p', 1, '{}', 'p1', NULL, '{}', '{}', 'full-access', 'default',
              'user', 'user', ${at}, ${at}, ${at}, 'succeeded', NULL, 1, NULL)`;
        yield* sql`
          INSERT INTO peer_environment_links (environment_id, secret_name, label, urls_json, access,
            linked_at, expires_at, last_reached_at, last_error)
          VALUES ('env-9', 'secret', 'Studio PC', '[]', 'full-access', ${at}, ${at}, NULL,
            'fetch failed')`;
        yield* detector.poll;
        yield* detector.poll;
        yield* detector.tick;
        const cards = yield* allCards;
        assert.sameMembers(
          cards.map((card) => [card.projectId, card.title].join(" ")),
          ["p1 Scheduled task: Project folder is missing", "scratch Connection: fetch failed"],
        );
        assert.isTrue(cards.every((card) => card.problem?.count === 1));
        assert.include(
          cards.find((card) => card.projectId === "scratch")!.description,
          "- **Where:** Studio PC",
        );
      }),
    );
  });
});
