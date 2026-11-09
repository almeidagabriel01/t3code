import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AssistantError,
  type AssistantsEvent,
  AssistantTeamId,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as Gate from "./AssistantGroupGate.ts";
import * as Groups from "./AssistantGroups.ts";
import { groupThreadId } from "./AssistantGroups.ts";
import { AssistantService } from "./AssistantService.ts";

class Boom extends Data.TaggedError("Boom") {}

const refusalError = (effect: Effect.Effect<object, AssistantError>) => Effect.flip(effect);

const TEAM = AssistantTeamId.make("team:1");
const OTHER_TEAM = AssistantTeamId.make("team:2");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const selection = (instanceId: ProviderInstanceId, model = "m"): ModelSelection => ({
  instanceId,
  model,
});
const adaThread = groupThreadId("ada", TEAM);
const betoThread = groupThreadId("beto", TEAM);
const cyThread = groupThreadId("cy", TEAM);

interface FakeThread {
  projectId: string;
  title: string;
  archivedAt: string | null;
  deletedAt: string | null;
  modelSelection: ModelSelection;
}
interface FakeRun {
  id: string;
  userMessageId: string;
  status: string;
}

interface Options {
  /** Members of the first team, in order. */
  readonly members?: ReadonlyArray<string>;
  readonly lead?: string | null;
  /** Provider instances whose text generation offers routing. */
  readonly routable?: ReadonlyArray<ProviderInstanceId>;
  /** What the summary call answers; "fail" errors it and "unsupported" leaves the operation out. */
  readonly summarize?: (call: number) => string | "fail" | "unsupported";
  /** Holds every summary call until it completes. */
  readonly summaryGate?: Deferred.Deferred<void>;
  readonly route?: (input: {
    readonly members: ReadonlyArray<{ readonly id: string }>;
  }) => ReadonlyArray<string> | "fail" | "none";
}

const harness = (options: Options = {}) => {
  const fakeThreads = new Map<string, FakeThread>();
  const runs = new Map<string, FakeRun[]>();
  const answers = new Map<string, string>();
  const sent: Array<{
    projectId: string;
    commandId: string;
    messageId: string;
    threadId: string;
    text: string;
    mode: string;
    createdBy: string;
    modelSelection?: ModelSelection;
    attachments: ReadonlyArray<{ id: string; type: string; name: string }>;
  }> = [];
  const cleaned: string[] = [];
  const dispatched: Array<{ type: string; threadId: string; commandId: string; runId?: string }> =
    [];
  const launched: Array<{
    commandId: string;
    threadId: string;
    projectId: string;
    title: string;
    runtimeMode: string;
    modelSelection: ModelSelection;
    generateTitle: boolean | undefined;
    createdBy: string;
  }> = [];
  const deletedTeams: string[] = [];
  const refreshed: string[] = [];
  const routeCalls: unknown[] = [];
  const summaryCalls: Array<{
    previousSummary: string | null;
    messages: ReadonlyArray<{ from: string; text: string }>;
  }> = [];
  const state = { failSend: false, failLaunch: false, deletedSignal: undefined as unknown };
  // Built with the layer, so each test gets its own.
  const live = {} as {
    changes: PubSub.PubSub<AssistantsEvent>;
    deleted: Deferred.Deferred<void>;
  };

  const addThread = (id: string, projectId: string, model: ModelSelection, title = id) =>
    fakeThreads.set(id, {
      projectId,
      title,
      archivedAt: null,
      deletedAt: null,
      modelSelection: model,
    });
  addThread("assistant:ada:1", "p1", selection(codex, "ada-model"));
  addThread("assistant:beto:1", "p1", selection(claude, "beto-model"));
  addThread("assistant:cy:1", "p1", selection(codex, "cy-model"));
  addThread("thread:outside", "p1", selection(codex), "Planning chat");

  const mocks = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      getThreadRecords: ((threadId: string, _fields: unknown, filter?: Record<string, unknown>) => {
        const statuses = filter?.runStatuses as ReadonlyArray<string> | undefined;
        const runIds = filter?.messageRunIds as ReadonlyArray<string> | undefined;
        return Effect.succeed({
          runs: (runs.get(threadId) ?? []).filter(
            (run) => statuses === undefined || statuses.includes(run.status),
          ),
          messages: (runIds ?? []).flatMap((runId) =>
            answers.has(runId) ? [{ role: "assistant", text: answers.get(runId) }] : [],
          ),
        });
      }) as never,
      dispatch: ((command: { type: string; threadId: string; commandId: string; runId?: string }) =>
        Effect.sync(() => {
          dispatched.push(command);
          const thread = fakeThreads.get(command.threadId);
          if (thread !== undefined) {
            if (command.type === "thread.archive") thread.archivedAt = "now";
            if (command.type === "thread.unarchive") thread.archivedAt = null;
            if (command.type === "thread.delete") thread.deletedAt = "now";
            if (command.type === "thread.metadata.update")
              thread.title = (command as { title?: string }).title ?? thread.title;
          }
          return {} as never;
        })) as never,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: ((threadId: string) => {
        const thread = fakeThreads.get(threadId);
        return thread === undefined ? Effect.fail(new Boom()) : Effect.succeed({ thread });
      }) as never,
      sendToThread: ((input: (typeof sent)[number]) => {
        if (state.failSend) return Effect.fail(new Boom());
        sent.push(input);
        runs.set(input.threadId, [
          ...(runs.get(input.threadId) ?? []),
          { id: `run:${input.messageId}`, userMessageId: input.messageId, status: "running" },
        ]);
        return Effect.succeed({});
      }) as never,
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: ((input: (typeof launched)[number]) => {
        if (state.failLaunch) return Effect.fail(new Boom());
        launched.push(input);
        if (!fakeThreads.has(input.threadId)) {
          addThread(input.threadId, input.projectId, input.modelSelection, input.title);
        }
        return Effect.succeed({ threadId: input.threadId });
      }) as never,
    }),
    Layer.effect(
      AssistantService,
      Effect.gen(function* () {
        live.changes = yield* PubSub.unbounded<AssistantsEvent>();
        return AssistantService.of({
          subscribeChanges: PubSub.subscribe(live.changes),
          refreshTeamChat: (teamId: string) => Effect.sync(() => void refreshed.push(teamId)),
          defaultModel: () => Effect.succeed(selection(codex, "default-model")),
        } as never);
      }),
    ),
    Layer.effect(
      ScheduledTaskService.ScheduledTaskService,
      Effect.gen(function* () {
        live.deleted = yield* Deferred.make<void>();
        return ScheduledTaskService.ScheduledTaskService.of({
          deleteForTeam: (teamId: string) =>
            Effect.sync(() => void deletedTeams.push(teamId)).pipe(
              Effect.andThen(Deferred.succeed(live.deleted, undefined)),
              Effect.asVoid,
            ),
        } as never);
      }),
    ),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed({
          textGeneration: (options.routable ?? []).includes(instanceId)
            ? { routeAssistantGroup: () => Effect.die("not used") }
            : {},
        } as never),
    }),
    Layer.mock(TextGeneration)({
      routeAssistantGroup: ((input: { members: ReadonlyArray<{ id: string }> }) => {
        routeCalls.push(input);
        const picked = options.route?.(input) ?? [];
        return picked === "fail"
          ? Effect.fail(new Boom())
          : picked === "none"
            ? Effect.succeed({ assistantIds: [], noReply: true })
            : Effect.succeed({ assistantIds: picked });
      }) as never,
      ...(options.summarize?.(0) === "unsupported"
        ? {}
        : {
            summarizeAssistantGroup: ((input: (typeof summaryCalls)[number]) => {
              summaryCalls.push(input);
              const answer = options.summarize?.(summaryCalls.length) ?? "A summary.";
              const result =
                answer === "fail" ? Effect.fail(new Boom()) : Effect.succeed({ summary: answer });
              return options.summaryGate === undefined
                ? result
                : Deferred.await(options.summaryGate).pipe(Effect.andThen(result));
            }) as never,
          }),
    }),
    Layer.mock(DocumentText.DocumentText)({ ensure: () => Effect.sync(() => undefined) }),
    Layer.succeed(ResourceCleanupService.ResourceCleanupService, {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: (ids) => Effect.sync(() => void cleaned.push(...ids)),
    }),
    ServerSettings.layerTest(),
  );
  const base = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "groups-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    SqlitePersistence.layerMemory,
  );
  const layer = Groups.layer.pipe(Layer.provideMerge(mocks.pipe(Layer.provideMerge(base))));

  const setup = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const assistant = (id: string, name: string, role: string, access = "workspace-write") =>
      sql`INSERT INTO assistants
        (assistant_id, handle, name, project_id, instructions, tool_access, thread_id, role, created_at, updated_at)
        VALUES (${id}, ${id}, ${name}, 'p1', ${`${name} does ${role}.`}, ${access},
          ${`assistant:${id}:1`}, ${role}, '2026-01-01', '2026-01-01')`;
    yield* assistant("ada", "Ada", "CFO", "read-only");
    yield* assistant("beto", "Beto", "Engineering");
    yield* assistant("cy", "Cy", "Design");
    const team = (id: string, members: ReadonlyArray<string>, lead: string | null) =>
      sql`INSERT INTO assistant_teams (team_id, name, member_ids_json, lead_id, created_at, updated_at)
        VALUES (${id}, ${`Team ${id}`}, ${JSON.stringify(members)}, ${lead}, '2026-01-01', '2026-01-01')`;
    yield* team(TEAM, options.members ?? ["ada", "beto", "cy"], options.lead ?? null);
    yield* team(OTHER_TEAM, ["ada"], null);
    return yield* Groups.AssistantGroups;
  });

  const user = { kind: "user" } as const;

  /** Ends the run the n-th queued task started, as the provider would, and feeds the event. */
  const finish = (index: number, status: string, answer?: string) =>
    Effect.gen(function* () {
      const groups = yield* Groups.AssistantGroups;
      const message = sent[index]!;
      const run = runs.get(message.threadId)!.find((r) => r.userMessageId === message.messageId)!;
      run.status = status;
      if (answer !== undefined) answers.set(run.id, answer);
      yield* groups.handleRunEvent({
        type: "run.updated",
        payload: {
          id: run.id,
          threadId: message.threadId,
          userMessageId: message.messageId,
          status,
        },
      } as never as OrchestrationV2DomainEvent);
    });

  const sqlRows = <T extends object>(query: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<T>(query);
    });
  const tasks = sqlRows<{
    task_id: string;
    owner_id: string;
    status: string;
    reason: string | null;
    revision: number;
    kind: string;
    hops: number;
    parent_id: string | null;
    followup: string | null;
    result_text: string | null;
  }>("SELECT * FROM assistant_group_tasks ORDER BY rowid");
  const messages = sqlRows<{
    message_id: string;
    seq: number;
    author: string;
    assistant_id: string | null;
    author_label: string | null;
    kind: string;
    text: string;
    reply_to: string | null;
    task_id: string | null;
  }>("SELECT * FROM assistant_group_messages ORDER BY seq");

  return {
    layer,
    setup,
    user,
    sent,
    dispatched,
    launched,
    fakeThreads,
    runs,
    live,
    deletedTeams,
    refreshed,
    cleaned,
    routeCalls,
    summaryCalls,
    state,
    finish,
    tasks,
    messages,
    sqlRows,
  };
};

const statusesOf = (rows: ReadonlyArray<{ owner_id: string; status: string }>) =>
  rows.map((row) => `${row.owner_id}:${row.status}`);

it.effect("an @mention opens one task per member, and the third waits for a free slot", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "@everyone close the books" }, h.user);
    assert.deepEqual(
      posted.tasks.map((task) => [task.ownerId, task.status, task.kind]),
      [
        ["ada", "running", "root"],
        ["beto", "running", "root"],
        ["cy", "queued", "root"],
      ],
    );
    assert.equal(posted.message.author, "user");
    assert.equal(posted.message.seq, 1);
    assert.equal(posted.tasks[0]!.threadId, adaThread);
    assert.deepEqual(
      h.sent.map((message) => message.threadId),
      [adaThread, betoThread],
    );
    // The first free slot goes to the oldest queued task.
    yield* h.finish(0, "completed", "Books closed.");
    assert.equal(h.sent.length, 3);
    assert.equal(h.sent[2]!.threadId, cyThread);
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:completed", "beto:running", "cy:running"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("tasks queue in order and start as slots free up", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    for (const text of ["@ada one", "@ada two", "@ada three", "@ada four"]) {
      yield* groups.post({ teamId: TEAM, text }, h.user);
    }
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.status),
      ["running", "running", "queued", "queued"],
    );
    yield* h.finish(1, "completed", "two done");
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.status),
      ["running", "completed", "running", "queued"],
    );
    assert.include(h.sent[2]!.text, "three");
    yield* h.finish(0, "completed", "one done");
    assert.include(h.sent[3]!.text, "four");
    assert.deepEqual(
      h.sent.map((message) => message.mode),
      ["queue", "queue", "queue", "queue"],
    );
    assert.isTrue(h.sent.every((message) => message.createdBy === "system"));
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "unread counts what others wrote after the read position, and the position moves both ways",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const chat = () =>
        h
          .sqlRows<{
            latest_seq: number;
            read_seq: number;
            unread_count: number;
            open_tasks: number;
            preview: string | null;
          }>(`SELECT * FROM assistant_team_state WHERE team_id = '${TEAM}'`)
          .pipe(Effect.map((rows) => rows[0]!));
      yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
      // The user's own message is never unread, and the open task shows as working.
      const started = yield* chat();
      assert.deepEqual([started.latest_seq, started.unread_count, started.open_tasks], [1, 0, 1]);
      yield* h.finish(0, "completed", "Done, boss.");
      const done = yield* chat();
      assert.deepEqual([done.unread_count, done.open_tasks, done.preview], [1, 0, "Done, boss."]);
      assert.isTrue(h.refreshed.length > 0);
      // Reading clamps to the newest message; a lower position makes later ones unread again.
      assert.equal((yield* groups.markRead({ teamId: TEAM, readSeq: 99 })).readSeq, 2);
      assert.equal((yield* chat()).unread_count, 0);
      assert.equal((yield* groups.markRead({ teamId: TEAM, readSeq: 1 })).readSeq, 1);
      assert.equal((yield* chat()).unread_count, 1);
      // Mark as unread lands just before the newest message from anyone but the user.
      yield* groups.markRead({ teamId: TEAM });
      assert.equal((yield* chat()).unread_count, 0);
      assert.equal((yield* groups.markRead({ teamId: TEAM, unread: true })).readSeq, 1);
      assert.equal((yield* chat()).unread_count, 1);
      const missing = yield* refusalError(
        groups.markRead({ teamId: AssistantTeamId.make("nope"), readSeq: 1 }),
      );
      assert.equal(missing.reason, "not_found");
    }).pipe(Effect.provide(h.layer));
  },
);

const recipientTable = [
  ["a leading @handle", "@beto please look", ["beto"]],
  ["several leading handles", "@ada, @cy both of you", ["ada", "cy"]],
  ["@everyone", "@everyone hello", ["ada", "beto", "cy"]],
] as const;
it.effect.each(recipientTable)("recipients: %s", ([, text, owners]) => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text }, h.user);
    assert.deepEqual(
      posted.tasks.map((task): string => task.ownerId),
      [...owners],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a reply to a member's message goes to that member's task owner", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@cy draft it" }, h.user);
    yield* h.finish(0, "completed", "Draft ready.");
    const answer = (yield* h.messages).find((message) => message.author === "assistant")!;
    const followUp = yield* groups.post(
      { teamId: TEAM, text: "shorter please", replyToMessageId: answer.message_id as never },
      h.user,
    );
    assert.deepEqual(
      followUp.tasks.map((task) => task.ownerId),
      ["cy"],
    );
    // A reply to something that is not a member's answer falls through to the next rule: with one
    // task open, its owner takes it.
    const again = yield* groups.post(
      { teamId: TEAM, text: "again", replyToMessageId: followUp.message.id },
      h.user,
    );
    assert.deepEqual(
      again.tasks.map((task) => task.ownerId),
      ["cy"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a group of one takes any message", () => {
  const h = harness({ members: ["ada"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "what is the runway?" }, h.user);
    assert.deepEqual(
      posted.tasks.map((task) => task.ownerId),
      ["ada"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a message that names no one is refused before it is stored when the lead cannot route",
  () => {
    const h = harness({ lead: "beto", routable: [codex] });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const error = yield* groups.post({ teamId: TEAM, text: "hello?" }, h.user).pipe(Effect.flip);
      assert.equal(error.reason, "mention_required");
      assert.equal(error.message, Groups.MENTION_REQUIRED_MESSAGE);
      assert.lengthOf(yield* h.messages, 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("with no lead a message is kept, and routed once a lead is set", () => {
  const h = harness({ lead: null, routable: [claude], route: () => ["cy"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    const posted = yield* groups.post({ teamId: TEAM, text: "who takes the logo?" }, h.user);
    assert.deepEqual(posted.tasks, []);
    assert.lengthOf(yield* h.messages, 1);
    assert.lengthOf(yield* h.tasks, 0);
    // Stays pending across a restart.
    yield* groups.reconcile;
    assert.lengthOf(yield* h.messages, 1);
    yield* sql`UPDATE assistant_teams SET lead_id = 'beto' WHERE team_id = ${TEAM}`;
    const team = {
      id: TEAM,
      memberIds: ["ada", "beto", "cy"],
      leadId: "beto",
      archivedAt: null,
    } as never;
    yield* groups.handleAssistantEvent({ type: "teamUpserted", team });
    yield* groups.idle;
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.owner_id),
      ["cy"],
    );
    yield* groups.handleAssistantEvent({ type: "teamUpserted", team });
    yield* groups.idle;
    assert.lengthOf(yield* h.tasks, 1);
    assert.lengthOf(h.routeCalls, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "the lead can decide a message needs no reply: no task, one muted line, never rerouted",
  () => {
    const h = harness({ lead: "beto", routable: [claude], route: () => "none" });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const posted = yield* groups.post({ teamId: TEAM, text: "ok, thanks" }, h.user);
      yield* groups.idle;
      assert.lengthOf(yield* h.tasks, 0);
      assert.deepEqual(
        (yield* h.messages).map((row) => [row.kind, row.text, row.reply_to]),
        [
          ["message", "ok, thanks", null],
          ["change", "No reply needed", posted.message.id],
        ],
      );
      yield* groups.reconcile;
      yield* groups.idle;
      assert.lengthOf(h.routeCalls, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a bare continue resumes the newest stopped task, before anything asks the lead", () => {
  const h = harness({ lead: "beto", routable: [claude], route: () => ["cy"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const first = yield* groups.post({ teamId: TEAM, text: "@ada draft the plan" }, h.user);
    yield* groups.taskAction({ taskId: first.tasks[0]!.id, action: "stop" });
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.status),
      ["paused"],
    );
    const posted = yield* groups.post({ teamId: TEAM, text: "Continua!" }, h.user);
    assert.deepEqual(posted.tasks, []);
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.owner_id, task.status]),
      [["ada", "running"]],
    );
    assert.lengthOf(h.sent, 2);
    const note = (yield* h.messages).at(-1)!;
    assert.deepEqual(
      [note.kind, note.text, note.reply_to],
      ["routing", "Resumed Ada's task", posted.message.id],
    );
    assert.lengthOf(h.routeCalls, 0);
    // Nothing is stopped now, so the next one goes the normal way (one task open: its owner).
    const next = yield* groups.post({ teamId: TEAM, text: "continue" }, h.user);
    assert.deepEqual(
      next.tasks.map((task) => task.ownerId),
      ["ada"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a follow-up goes to the owner of the one open task; with several open the lead routes",
  () => {
    const h = harness({ lead: "beto", routable: [claude], route: () => ["cy"] });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada the budget" }, h.user);
      const followUp = yield* groups.post({ teamId: TEAM, text: "include Q3 too" }, h.user);
      assert.deepEqual(
        followUp.tasks.map((task) => task.ownerId),
        ["ada"],
      );
      assert.lengthOf(h.routeCalls, 0);
      yield* groups.post({ teamId: TEAM, text: "@cy the logo" }, h.user);
      yield* groups.post({ teamId: TEAM, text: "and what about the date?" }, h.user);
      yield* groups.idle;
      assert.lengthOf(h.routeCalls, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("an agent's message never resumes or follows up; the lead routes it", () => {
  const h = harness({ lead: "beto", routable: [claude], route: () => ["cy"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada the budget" }, h.user);
    yield* groups.post(
      { teamId: TEAM, text: "any news?" },
      { kind: "agent", assistantId: null, label: "Planning chat" },
    );
    yield* groups.idle;
    assert.lengthOf(h.routeCalls, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("an archived or missing group takes no message", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = ${TEAM}`;
    assert.equal(
      (yield* groups.post({ teamId: TEAM, text: "@ada hi" }, h.user).pipe(Effect.flip)).reason,
      "archived",
    );
    assert.equal(
      (yield* groups
        .post({ teamId: AssistantTeamId.make("nope"), text: "@ada hi" }, h.user)
        .pipe(Effect.flip)).reason,
      "not_found",
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a repeated clientRequestId returns the first message and its tasks, storing nothing",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const input = { teamId: TEAM, text: "@ada once", clientRequestId: "req-1" };
      const first = yield* groups.post(input, h.user);
      const again = yield* groups.post(input, h.user);
      assert.equal(again.message.id, first.message.id);
      assert.deepEqual(
        again.tasks.map((task) => task.id),
        first.tasks.map((task) => task.id),
      );
      assert.lengthOf(yield* h.messages, 1);
      assert.lengthOf(h.sent, 1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("agents and schedules open tasks whose instruction names their sender", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post(
      { teamId: TEAM, text: "@ada check the invoice" },
      { kind: "agent", assistantId: null, label: "Planning chat" },
    );
    yield* groups.post(
      { teamId: TEAM, text: "@ada weekly report" },
      { kind: "routine", label: "Monday report" },
    );
    const rows = yield* h.messages;
    assert.deepEqual(
      rows.map((row) => [row.author, row.author_label]),
      [
        ["agent", "Planning chat"],
        ["routine", "Monday report"],
      ],
    );
    assert.include(h.sent[0]!.text, "Request from Planning chat (an agent, not the user):");
    assert.include(h.sent[1]!.text, "Scheduled request Monday report:");
    assert.notInclude(h.sent[0]!.text, "from the user");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a member's exec thread is launched once, lazily, like its own conversation", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    // Ada switched models in her own conversation: the next task in the group follows.
    h.fakeThreads.get("assistant:ada:1")!.modelSelection = selection(claude, "ada-new");
    yield* groups.post({ teamId: TEAM, text: "@ada two" }, h.user);
    assert.deepEqual(
      h.sent.map((input) => input.modelSelection),
      [selection(codex, "ada-model"), selection(claude, "ada-new")],
    );
    assert.lengthOf(h.launched, 1);
    assert.deepInclude(h.launched[0], {
      commandId: "assistant-group-launch:team:1:ada",
      threadId: adaThread,
      projectId: "p1",
      title: "Ada · Team team:1",
      // Ada is read-only, so the thread asks before acting.
      runtimeMode: "approval-required",
      modelSelection: selection(codex, "ada-model"),
      generateTitle: false,
      createdBy: "system",
    });
    assert.match(adaThread, /^assistant:ada:g-[0-9a-f]{16}$/);
    assert.deepEqual(
      (yield* h.sqlRows<{ thread_id: string }>(
        "SELECT thread_id FROM assistant_group_threads",
      )).map((row) => row.thread_id),
      [adaThread],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a task that cannot start fails with a reason the user can see", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    h.state.failLaunch = true;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    h.state.failLaunch = false;
    h.state.failSend = true;
    yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
    // A thread that was deleted behind the group's back is not relaunched.
    h.state.failSend = false;
    h.fakeThreads.get(betoThread)!.deletedAt = "now";
    yield* groups.post({ teamId: TEAM, text: "@beto three" }, h.user);
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.status, task.reason]),
      [
        ["failed", "thread_unavailable"],
        ["failed", "could_not_start"],
        ["failed", "thread_unavailable"],
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("the packet carries what the member has not seen, once", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada first" }, h.user);
    const packet = h.sent[0]!.text;
    assert.include(packet, `<t3_group_task group="Team team:1" task="`);
    assert.include(packet, 'kind="root">');
    assert.include(packet, 'You are Ada (@ada) in the group "Team team:1".');
    assert.include(
      packet,
      "Members: Ada (@ada, CFO), Beto (@beto, Engineering), Cy (@cy, Design).",
    );
    assert.include(packet, "Your task, from the user: @ada first");
    // The request is the task, so it is not repeated as news.
    assert.notInclude(packet, "New in the group chat");
    yield* h.finish(0, "completed", "ok one");
    yield* groups.post({ teamId: TEAM, text: "@beto second" }, h.user);
    yield* groups.post({ teamId: TEAM, text: "@ada third" }, h.user);
    const next = h.sent[2]!.text;
    // Ada's own answer is already in her thread; Beto's request is news to her.
    assert.include(next, "[#3 user] @beto second");
    assert.notInclude(next, "ok one");
    assert.notInclude(next, "[#2");
    yield* h.finish(2, "completed", "ok three");
    yield* groups.post({ teamId: TEAM, text: "@ada fourth" }, h.user);
    assert.notInclude(h.sent[3]!.text, "second");
  }).pipe(Effect.provide(h.layer));
});

const bulk = (letter: string) => `@ada ${letter.repeat(Groups.SUMMARY_TRIGGER_CHARS / 2 + 100)}`;

it.effect("a long chat is summarized incrementally and the next packet carries the summary", () => {
  const h = harness({ summarize: (call) => `Summary ${call}.` });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada short" }, h.user);
    yield* groups.idle;
    assert.lengthOf(h.summaryCalls, 0);
    yield* groups.post({ teamId: TEAM, text: bulk("a") }, h.user);
    yield* groups.post({ teamId: TEAM, text: bulk("b") }, h.user);
    yield* groups.idle;
    assert.lengthOf(h.summaryCalls, 1);
    assert.isNull(h.summaryCalls[0]!.previousSummary);
    assert.lengthOf(h.summaryCalls[0]!.messages, 3);
    yield* h.finish(0, "completed", "ok");
    yield* h.finish(1, "completed", "ok");
    yield* groups.post({ teamId: TEAM, text: "@beto hello" }, h.user);
    const packet = h.sent.find((message) => message.threadId === betoThread)!.text;
    assert.include(packet, "Summary of earlier chat:\nSummary 1.");
    yield* groups.post({ teamId: TEAM, text: bulk("c") }, h.user);
    yield* groups.post({ teamId: TEAM, text: bulk("d") }, h.user);
    yield* groups.idle;
    // The second pass folds in only what came after the first.
    assert.lengthOf(h.summaryCalls, 2);
    assert.equal(h.summaryCalls[1]!.previousSummary, "Summary 1.");
    assert.deepEqual(
      h.summaryCalls[1]!.messages.map((message) => message.text.slice(0, 7)),
      ["ok", "ok", "@beto h", "@ada cc", "@ada dd"],
    );
    const rows = yield* h.sqlRows<{ summary: string; through_seq: number }>(
      "SELECT * FROM assistant_group_summaries",
    );
    assert.deepEqual(
      rows.map((row) => row.summary),
      ["Summary 2."],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a summary that fails, is empty or is unsupported never touches the tasks", () => {
  const failing = harness({ summarize: () => "fail" });
  const empty = harness({ summarize: () => "  " });
  const unsupported = harness({ summarize: () => "unsupported" });
  const run = (h: ReturnType<typeof harness>) =>
    Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: bulk("a") }, h.user);
      yield* groups.post({ teamId: TEAM, text: bulk("b") }, h.user);
      yield* groups.idle;
      assert.isAtLeast(h.sent.length, 1);
      assert.notInclude(h.sent.at(-1)!.text, "Summary of earlier chat");
      assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
    }).pipe(Effect.provide(h.layer));
  return Effect.gen(function* () {
    yield* run(failing);
    // A failed attempt waits for the chat to move on before it asks again.
    assert.lengthOf(failing.summaryCalls, 1);
    yield* run(empty);
    yield* run(unsupported);
  });
});

it.effect("a task also carries the older messages it names by #seq or replies to", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada the budget is 5k" }, h.user);
    yield* h.finish(0, "completed", "noted");
    yield* groups.post({ teamId: TEAM, text: "@ada what about #1 and #99?" }, h.user);
    assert.include(
      h.sent[1]!.text,
      "Earlier messages this task refers to:\n[#1 user] @ada the budget is 5k",
    );
    assert.notInclude(h.sent[1]!.text, "#99 ");
    yield* h.finish(1, "completed", "yes");
    const second = (yield* h.messages)[2]!;
    yield* groups.post(
      { teamId: TEAM, text: "@ada and this?", replyToMessageId: second.message_id as never },
      h.user,
    );
    assert.include(h.sent[2]!.text, "[#3 user] @ada what about #1");
  }).pipe(Effect.provide(h.layer));
});

const outcomeTable = [
  ["completed with an answer", "completed", "All done.", null, "completed", "All done."],
  ["completed with no words", "completed", undefined, null, "completed", "(no answer)"],
  [
    "completed after result was called",
    "completed",
    "ignored",
    "Explicit result",
    "completed",
    "Explicit result",
  ],
  ["interrupted", "interrupted", undefined, null, "paused", null],
  ["failed", "failed", undefined, null, "failed", null],
  ["cancelled by the provider", "cancelled", undefined, null, "failed", null],
] as const;
it.effect.each(outcomeTable)("run outcome: %s", ([, runStatus, answer, result, status, posted]) => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    if (result !== null) {
      yield* groups.member.result({ callerThreadId: adaThread, text: result });
    }
    yield* h.finish(0, runStatus, answer);
    const [task] = yield* h.tasks;
    assert.equal(task!.status, status);
    const rows = (yield* h.messages).filter((row) => row.author === "assistant");
    assert.deepEqual(
      rows.map((row) => row.text),
      posted === null ? [] : [posted],
    );
    if (posted !== null) {
      const [row] = rows;
      assert.deepEqual(
        [row!.assistant_id, row!.task_id, row!.kind],
        ["ada", task!.task_id, "message"],
      );
      assert.equal(row!.reply_to, (yield* h.messages)[0]!.message_id);
    }
    if (runStatus === "interrupted") assert.equal(task!.reason, "stopped");
  }).pipe(Effect.provide(h.layer));
});

it.effect("an old revision's run ending, or one for a stopped task, changes nothing", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const id = posted.tasks[0]!.id;
    yield* groups.taskAction({ taskId: id, action: "stop" });
    yield* groups.taskAction({ taskId: id, action: "resume" });
    assert.equal(h.sent.length, 2);
    // The first run (revision 1) ends late: the task is on revision 2.
    yield* h.finish(0, "completed", "stale");
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.status, task.revision]),
      [["running", 2]],
    );
    assert.lengthOf(yield* h.messages, 1);
    // Events that are not group runs, or not task messages, are ignored.
    yield* groups.handleRunEvent({
      type: "run.updated",
      payload: { id: "r", threadId: "thread:plain", userMessageId: "x", status: "completed" },
    } as never);
    yield* groups.handleRunEvent({
      type: "run.updated",
      payload: { id: "r", threadId: adaThread, userMessageId: "plain", status: "completed" },
    } as never);
    yield* groups.handleRunEvent({ type: "thread.created", payload: {} } as never);
    assert.equal((yield* h.tasks)[0]!.status, "running");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a task handed over mid-run goes to the new owner when the run ends, posting nothing",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
      yield* groups.member.result({ callerThreadId: adaThread, text: "Ada's stale result" });
      const handed = yield* groups.member.transfer({
        callerThreadId: adaThread,
        member: "@beto",
        note: "numbers are in the sheet",
      });
      assert.equal(handed.status, "running");
      // A repeat is the same hand-over.
      yield* groups.member.transfer({ callerThreadId: adaThread, member: "beto", note: "again" });
      yield* h.finish(0, "completed", "I handed it off.");
      assert.lengthOf(yield* h.messages, 1);
      // Ada's explicit result belonged to her run: Beto's answer is what gets posted.
      yield* h.finish(1, "completed", "Beto's own answer");
      const posted = (yield* h.messages).at(-1)!;
      assert.deepEqual([posted.assistant_id, posted.text], ["beto", "Beto's own answer"]);
      const [task] = yield* h.tasks;
      // The hand-over counts against the request's cap once, however often it was repeated.
      assert.deepEqual(
        [task!.owner_id, task!.status, task!.revision, task!.hops],
        ["beto", "completed", 2, 1],
      );
      assert.equal(h.sent[1]!.threadId, betoThread);
      assert.include(
        h.sent[1]!.text,
        "Ada (a teammate, not the user) handed this task to you: numbers are in the sheet",
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a task waits for what it assigned, then runs again with the results", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada plan the launch" }, h.user);
    const child = yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "beto",
      instruction: "Check the build",
    });
    assert.equal(child.status, "running");
    // A repeat of the same assignment is the same task.
    const repeat = yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "@beto",
      instruction: "Check the build",
    });
    assert.equal(repeat.taskId, child.taskId);
    assert.include(
      h.sent[1]!.text,
      "Your task, from Ada (a teammate, not the user): Check the build",
    );
    assert.include(h.sent[1]!.text, 'kind="child"');

    yield* h.finish(0, "completed", "Waiting on Beto.");
    const rows = yield* h.tasks;
    assert.deepEqual(statusesOf(rows), ["ada:waiting", "beto:running"]);
    assert.equal((yield* h.messages).filter((row) => row.author === "assistant").length, 0);

    yield* h.finish(1, "completed", "Build is green.");
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:running", "beto:completed"]);
    const [root] = yield* h.tasks;
    assert.equal(root!.revision, 2);
    assert.equal(h.sent[2]!.threadId, adaThread);
    assert.include(h.sent[2]!.text, "The tasks you gave are finished:");
    assert.include(h.sent[2]!.text, "- Beto (completed): Build is green.");
    // Beto's answer is in the chat; Ada's follows when she is done.
    yield* h.finish(2, "completed", "Launch plan ready.");
    assert.deepEqual(
      (yield* h.messages).map((row) => [row.assistant_id ?? row.author, row.text]),
      [
        ["user", "@ada plan the launch"],
        ["beto", "Build is green."],
        ["ada", "Launch plan ready."],
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a failed child still lets the parent continue, and says it failed", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.member.assign({ callerThreadId: adaThread, member: "beto", instruction: "Try" });
    yield* h.finish(0, "completed", "waiting");
    yield* h.finish(1, "failed");
    assert.include(h.sent[2]!.text, "- Beto (failed):");
  }).pipe(Effect.provide(h.layer));
});

it.effect("assignments stop at the hand-off cap and wait for the user", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE assistant_group_tasks SET hops = 8`;
    const over = yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "beto",
      instruction: "One too many",
    });
    assert.equal(over.status, "paused");
    const notice = (yield* h.messages).at(-1)!;
    assert.deepEqual(
      [notice.kind, notice.text],
      ["notice", "Paused · hit 8 hand-offs for this request"],
    );
    assert.lengthOf(h.sent, 1);
    const [root, child] = yield* h.tasks;
    assert.deepEqual([root!.hops, child!.reason], [8, "handoff_limit"]);

    // A transfer over the cap pauses the task with its new owner.
    const moved = yield* groups.member.transfer({
      callerThreadId: adaThread,
      member: "cy",
      note: "",
    });
    assert.equal(moved.status, "paused");
    const [after] = yield* h.tasks;
    assert.deepEqual([after!.owner_id, after!.reason], ["cy", "handoff_limit"]);

    // Resuming the paused assignment is the user's call, so the cap does not stop it.
    yield* groups.taskAction({ taskId: over.taskId, action: "resume" });
    assert.equal((yield* h.tasks)[1]!.status, "running");
  }).pipe(Effect.provide(h.layer));
});

it.effect("member tools refuse misuse with a reason the model can act on", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const refusal = (effect: Effect.Effect<object, AssistantError>) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => `${error.reason}: ${error.message}`),
      );
    const call = groups.member;
    const ada = adaThread;
    assert.equal(
      yield* refusal(call.assign({ callerThreadId: ada, member: "nobody", instruction: "x" })),
      "invalid: There is no member @nobody in this group.",
    );
    assert.equal(
      yield* refusal(call.assign({ callerThreadId: ada, member: "ada", instruction: "x" })),
      "invalid: Do not assign a task to yourself.",
    );
    assert.equal(
      yield* refusal(call.history({ callerThreadId: ThreadId.make("thread:outside") })),
      "invalid: This tool only works inside a group task.",
    );
    assert.equal(
      yield* refusal(call.result({ callerThreadId: betoThread, text: "x" })),
      "invalid: This tool only works inside a group task.",
    );
    // Beto has no task yet, even though its thread exists.
    yield* groups.post({ teamId: TEAM, text: "@cy hi" }, h.user);
    yield* h.finish(1, "completed", "done");
    assert.equal(
      yield* refusal(call.result({ callerThreadId: cyThread, text: "x" })),
      "invalid: No task of yours is running in this group.",
    );
    const long = "q".repeat(501);
    assert.include(
      yield* refusal(call.reply({ callerThreadId: ada, messageId: "gm:none", text: long })),
      "under 500 characters",
    );
    const answer = (yield* h.messages).find((row) => row.author === "assistant")!;
    for (const [messageId, expected] of [
      ["gm:none", "Reply to a message a member wrote in this group."],
      [(yield* h.messages)[0]!.message_id, "Reply to a message a member wrote in this group."],
    ] as const) {
      assert.equal(
        yield* refusal(call.reply({ callerThreadId: ada, messageId, text: "q?" })),
        `invalid: ${expected}`,
      );
    }
    assert.equal(
      yield* refusal(
        call.reply({ callerThreadId: cyThread, messageId: answer.message_id, text: "q?" }),
      ),
      "invalid: No task of yours is running in this group.",
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("questions between members: two per request, a reply task only answers", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    // Beto and Cy each have an answer in the chat to ask about.
    yield* groups.post({ teamId: TEAM, text: "@beto @cy prepare" }, h.user);
    yield* h.finish(0, "completed", "Beto's draft");
    yield* h.finish(1, "completed", "Cy's draft");
    const [, betoAnswer, cyAnswer] = yield* h.messages;
    yield* groups.post({ teamId: TEAM, text: "@ada review them" }, h.user);

    const first = yield* groups.member.reply({
      callerThreadId: adaThread,
      messageId: betoAnswer!.message_id,
      text: "Which build?",
    });
    assert.isTrue(first.accepted);
    // A repeat of the same question is the same reply.
    const repeat = yield* groups.member.reply({
      callerThreadId: adaThread,
      messageId: betoAnswer!.message_id,
      text: "Which build?",
    });
    assert.deepEqual(repeat, first);
    assert.lengthOf(
      (yield* h.tasks).filter((task) => task.kind === "reply"),
      1,
    );

    const question = h.sent.at(-1)!;
    assert.equal(question.threadId, betoThread);
    assert.include(question.text, 'kind="reply"');
    assert.include(
      question.text,
      "Your task: Question from Ada (a teammate, not the user): Which build?",
    );
    assert.include(question.text, "only answers the question");

    // Ada cannot post her result while the question is open.
    const blocked = yield* groups.member.result({ callerThreadId: adaThread, text: "Done" });
    assert.isFalse(blocked.accepted);

    // The asked member may only answer: nothing else works from a reply task.
    for (const attempt of [
      groups.member.assign({ callerThreadId: betoThread, member: "cy", instruction: "x" }),
      groups.member.transfer({ callerThreadId: betoThread, member: "cy", note: "" }),
      groups.member.reply({
        callerThreadId: betoThread,
        messageId: cyAnswer!.message_id,
        text: "?",
      }),
    ]) {
      const error = yield* refusalError(attempt);
      assert.equal(error.message, "This task only answers a question. Use t3_group result.");
    }

    // The member message by its number in the chat, as the packet shows it.
    const second = yield* groups.member.reply({
      callerThreadId: adaThread,
      seq: cyAnswer!.seq,
      text: "Which font?",
    });
    assert.isTrue(second.accepted);
    // The third question of the same request is refused, whoever writes it.
    const third = yield* groups.member.reply({
      callerThreadId: adaThread,
      messageId: betoAnswer!.message_id,
      text: "And the date?",
    });
    assert.deepEqual(third, { accepted: false, message: Groups.REPLY_LIMIT_MESSAGE });

    // A failed question counts as settled, so Ada can finish.
    // Ada holds one slot and Beto's question the other, so Cy's question waits for Beto's to end.
    assert.lengthOf(h.sent, 4);
    yield* h.finish(3, "failed");
    assert.lengthOf(h.sent, 5);
    yield* h.finish(4, "completed", "Cy answers: Inter");
    const ok = yield* groups.member.result({ callerThreadId: adaThread, text: "Review done" });
    assert.isTrue(ok.accepted);
  }).pipe(Effect.provide(h.layer));
});

const seedTask = (
  status: string,
  extra: { readonly parent?: string; readonly owner?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `gt:${status}${extra.parent === undefined ? "" : ":child"}`;
    yield* sql`INSERT OR IGNORE INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, created_at)
      VALUES ('gm:seed', ${TEAM}, 1, 'user', 'message', 'seed', '2026-01-01')`;
    yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction, status,
       revision, hops, created_at, updated_at)
      VALUES (${id}, ${TEAM}, ${extra.parent ?? id}, ${extra.parent ?? null},
        ${extra.parent === undefined ? "root" : "child"}, 'gm:seed', ${extra.owner ?? "ada"}, 'seeded',
        ${status}, 1, 0, '2026-01-01', '2026-01-01')`;
    return id;
  });

const actionTable: ReadonlyArray<
  readonly [string, AssistantGroupTaskAction, ReadonlyArray<string>, string | undefined]
> = [
  ["stop", "stop", ["queued", "running", "waiting"], "paused"],
  ["resume", "resume", ["paused", "failed"], "running"],
  ["reassign", "reassign", ["paused", "failed"], "running"],
  ["cancel", "cancel", ["paused", "failed"], "cancelled"],
];
it.effect.each(actionTable)(
  "task action %s works on its states and refuses the others",
  ([_name, action, allowed, after]) => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      for (const status of [
        "queued",
        "running",
        "waiting",
        "paused",
        "failed",
        "completed",
        "cancelled",
      ]) {
        // Seeded tasks that are queued or running would hold the group's two slots.
        yield* sql`DELETE FROM assistant_group_tasks`;
        const id = yield* seedTask(status);
        const result = yield* groups
          .taskAction({
            taskId: id as never,
            action,
            ...(action === "reassign" ? { ownerId: "cy" as never } : {}),
          })
          .pipe(Effect.result);
        if (allowed.includes(status)) {
          assert.equal(result._tag, "Success", `${action} on ${status}`);
          const task = (result as { success: AssistantGroupTask }).success;
          assert.equal(task.status, after);
          if (action === "stop") assert.equal(task.reason, "stopped");
          if (action === "reassign") assert.equal(task.ownerId, "cy");
        } else {
          assert.equal(result._tag, "Failure", `${action} on ${status}`);
          assert.equal((result as { failure: { reason: string } }).failure.reason, "invalid");
        }
      }
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "resume and reassign need a member who is in the group; unknown tasks are not found",
  () => {
    const h = harness({ members: ["ada", "beto"] });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const gone = yield* seedTask("paused", { owner: "cy" });
      const refuse = (input: Parameters<typeof groups.taskAction>[0]) =>
        groups.taskAction(input).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.equal(
        yield* refuse({ taskId: gone as never, action: "resume" }),
        "Its member is no longer in the group; reassign it.",
      );
      assert.equal(
        yield* refuse({ taskId: gone as never, action: "reassign", ownerId: "cy" as never }),
        "That member is not in the group.",
      );
      assert.equal(
        yield* refuse({ taskId: gone as never, action: "reassign" }),
        "Choose the member that takes the task.",
      );
      assert.equal(
        (yield* groups.taskAction({ taskId: "gt:none" as never, action: "stop" }).pipe(Effect.flip))
          .reason,
        "not_found",
      );
      const reassigned = yield* groups.taskAction({
        taskId: gone as never,
        action: "reassign",
        ownerId: "beto" as never,
      });
      assert.deepEqual([reassigned.ownerId, reassigned.status], ["beto", "running"]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("stop pauses a task and what it assigned, ends their runs, and frees the slot", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.member.assign({ callerThreadId: adaThread, member: "beto", instruction: "Part" });
    yield* groups.post({ teamId: TEAM, text: "@cy other" }, h.user);
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:running", "beto:running", "cy:queued"]);
    const [root] = yield* h.tasks;
    yield* groups.taskAction({ taskId: root!.task_id as never, action: "stop" });
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:paused", "beto:paused", "cy:running"]);
    assert.deepEqual(
      h.dispatched.filter((command) => command.type === "run.interrupt").map((c) => c.threadId),
      [adaThread, betoThread],
    );
    // The interruption that follows changes nothing: the tasks were already paused.
    yield* h.finish(0, "interrupted");
    assert.equal((yield* h.tasks)[0]!.status, "paused");
    assert.equal((yield* h.tasks)[0]!.reason, "stopped");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a queued run that has not started is cancelled instead of interrupted", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    h.runs.get(adaThread)![0]!.status = "queued";
    yield* groups.taskAction({ taskId: posted.tasks[0]!.id, action: "stop" });
    assert.deepEqual(
      h.dispatched.map((command) => command.type),
      ["queued-run.cancel"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("cancel ends every open task of the request", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const root = yield* seedTask("paused");
    yield* seedTask("running", { parent: root, owner: "beto" });
    const other = yield* seedTask("completed");
    yield* groups.taskAction({ taskId: root as never, action: "cancel" });
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.task_id, task.status]),
      [
        [root, "cancelled"],
        [`${root.replace("gt:paused", "gt:running")}:child`, "cancelled"],
        [other, "completed"],
      ],
    );
    assert.deepEqual(
      h.dispatched.filter((c) => c.type === "run.interrupt" || c.type === "queued-run.cancel"),
      [],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a member leaving pauses its work and archives its thread; coming back unarchives it",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
      yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
      yield* sql`UPDATE assistant_teams SET member_ids_json = '["beto","cy"]' WHERE team_id = ${TEAM}`;
      const team = (yield* sql<{
        team_id: string;
        name: string;
      }>`SELECT * FROM assistant_teams WHERE team_id = ${TEAM}`)[0]!;
      yield* groups.handleAssistantEvent({
        type: "teamUpserted",
        team: {
          id: team.team_id,
          name: team.name,
          memberIds: ["beto", "cy"],
          archivedAt: null,
        } as never,
      });
      assert.deepEqual(
        (yield* h.tasks).map((task) => [task.owner_id, task.status, task.reason]),
        [
          ["ada", "paused", "member_removed"],
          ["beto", "running", null],
        ],
      );
      assert.deepEqual(
        h.dispatched.map((command) => [command.type, command.threadId]),
        [
          ["run.interrupt", adaThread],
          ["thread.archive", adaThread],
        ],
      );
      // Repeating the event does nothing more.
      yield* groups.handleAssistantEvent({
        type: "teamUpserted",
        team: {
          id: team.team_id,
          name: team.name,
          memberIds: ["beto", "cy"],
          archivedAt: null,
        } as never,
      });
      assert.lengthOf(h.dispatched, 2);

      yield* sql`UPDATE assistant_teams SET member_ids_json = '["ada","beto","cy"]' WHERE team_id = ${TEAM}`;
      const [paused] = yield* h.tasks;
      yield* groups.taskAction({ taskId: paused!.task_id as never, action: "resume" });
      assert.deepEqual(
        h.dispatched.slice(2).map((command) => command.type),
        ["thread.unarchive"],
      );
      assert.equal((yield* h.tasks)[0]!.status, "running");

      // Renaming the group renames the members' hidden threads, once.
      const renamed = {
        id: team.team_id,
        name: "Board",
        memberIds: ["ada", "beto", "cy"],
        archivedAt: null,
      } as never;
      yield* groups.handleAssistantEvent({ type: "teamUpserted", team: renamed });
      yield* groups.handleAssistantEvent({ type: "teamUpserted", team: renamed });
      assert.deepEqual(
        h.dispatched
          .filter((command) => command.type === "thread.metadata.update")
          .map((command) => [command.threadId, (command as { title?: string }).title]),
        [
          [adaThread, "Ada · Board"],
          [betoThread, "Beto · Board"],
        ],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("an archived group pauses everything and stays paused when restored", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* groups.post({ teamId: TEAM, text: "@everyone go" }, h.user);
    yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = ${TEAM}`;
    const archived = { id: TEAM, memberIds: ["ada", "beto", "cy"], archivedAt: "now" } as never;
    yield* groups.handleAssistantEvent({ type: "teamUpserted", team: archived });
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.status, task.reason]),
      [
        ["paused", "group_archived"],
        ["paused", "group_archived"],
        ["paused", "group_archived"],
      ],
    );
    assert.equal(h.dispatched.filter((command) => command.type === "run.interrupt").length, 2);
    const [first] = yield* h.tasks;
    // Nothing resumes inside an archived group.
    assert.equal(
      (yield* groups
        .taskAction({ taskId: first!.task_id as never, action: "resume" })
        .pipe(Effect.flip)).reason,
      "archived",
    );
    yield* sql`UPDATE assistant_teams SET archived_at = NULL WHERE team_id = ${TEAM}`;
    yield* groups.handleAssistantEvent({
      type: "teamUpserted",
      team: { ...(archived as object), archivedAt: null } as never,
    });
    assert.isTrue((yield* h.tasks).every((task) => task.status === "paused"));
    yield* groups.taskAction({ taskId: first!.task_id as never, action: "resume" });
    assert.equal((yield* h.tasks)[0]!.status, "running");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a deleted group takes its runs, threads, chat and schedules with it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.post({ teamId: OTHER_TEAM, text: "@ada elsewhere" }, h.user);
    yield* groups.handleAssistantEvent({ type: "teamRemoved", teamId: TEAM });
    assert.deepEqual(h.deletedTeams, [TEAM]);
    assert.deepEqual(
      h.dispatched.map((command) => [command.type, command.threadId]),
      [
        ["run.interrupt", adaThread],
        ["thread.delete", adaThread],
      ],
    );
    const left = yield* h.sqlRows<{ team_id: string }>(
      "SELECT team_id FROM assistant_group_tasks UNION ALL SELECT team_id FROM assistant_group_messages UNION ALL SELECT team_id FROM assistant_group_threads",
    );
    assert.isTrue(left.every((row) => row.team_id === OTHER_TEAM));
    assert.isAbove(left.length, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a deleted assistant's group threads go, and its open work waits for a new owner", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.handleAssistantEvent({ type: "removed", assistantId: "ada" as never });
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.status, task.reason]),
      [["paused", "member_removed"]],
    );
    assert.deepEqual(
      h.dispatched.map((command) => command.type),
      ["run.interrupt", "thread.delete"],
    );
    assert.lengthOf(yield* h.sqlRows("SELECT 1 FROM assistant_group_threads"), 0);
    // Other assistant changes are not the group's business.
    yield* groups.handleAssistantEvent({ type: "upserted", assistant: {} as never });
    assert.lengthOf(h.dispatched, 2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("on start, changes made while the server was down are applied", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    // The group and the assistant vanished while down; another group was archived.
    yield* sql`DELETE FROM assistant_teams WHERE team_id = ${TEAM}`;
    yield* sql`DELETE FROM assistants WHERE assistant_id = 'ada'`;
    yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = ${OTHER_TEAM}`;
    yield* groups.start;
    yield* Deferred.await(h.live.deleted);
    // The deletion started before its rows went; the next pass waits for the first to finish.
    yield* groups.reconcile;
    assert.deepEqual(h.deletedTeams, [TEAM]);
    assert.lengthOf(yield* h.tasks, 0);
    // The stream is live: a later removal arrives through it.
    yield* PubSub.publish(h.live.changes, { type: "teamRemoved", teamId: OTHER_TEAM });
    yield* groups.reconcile;
  }).pipe(Effect.provide(h.layer));
});

it.effect("on start, a message the lead was still routing is routed again", () => {
  const h = harness({ lead: "beto", routable: [claude], route: () => ["cy"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    // The server stopped after storing the message and before the lead answered.
    yield* sql`
      INSERT INTO assistant_group_messages (message_id, team_id, seq, author, kind, text, created_at)
      VALUES ('gm:lost', ${TEAM}, 1, 'user', 'message', 'Who takes the logo?', 'now')`;
    yield* groups.reconcile;
    yield* groups.idle;
    assert.deepEqual(
      (yield* h.sqlRows<{ owner_id: string; request_message_id: string }>(
        "SELECT owner_id, request_message_id FROM assistant_group_tasks",
      )).map((task) => [task.owner_id, task.request_message_id]),
      [["cy", "gm:lost"]],
    );
    // Routed once: a second pass finds its task.
    yield* groups.reconcile;
    yield* groups.idle;
    assert.lengthOf(yield* h.tasks, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("on start, a message nobody can route any more says so in the chat", () => {
  const h = harness({ lead: "beto", routable: [codex] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistant_group_messages (message_id, team_id, seq, author, kind, text, created_at)
      VALUES ('gm:lost', ${TEAM}, 1, 'user', 'message', 'Who takes the logo?', 'now')`;
    yield* groups.reconcile;
    yield* groups.reconcile;
    const notices = (yield* h.messages).filter((row) => row.kind === "notice");
    assert.deepEqual(
      notices.map((row) => [row.reply_to, row.text]),
      [["gm:lost", "Nobody got this message. Mention a member with @ to send it again."]],
    );
    assert.lengthOf(yield* h.tasks, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "the lead routes a message that names no one: picks, drops unknown ids, notes who",
  () => {
    const h = harness({
      lead: "beto",
      routable: [claude],
      route: () => ["ada", "ghost", "cy", "ada"],
    });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const posted = yield* groups.post(
        { teamId: TEAM, text: "Need the budget and a logo" },
        h.user,
      );
      // The message is stored and returned at once; routing follows in the background.
      assert.deepEqual(posted.tasks, []);
      yield* groups.idle;
      assert.deepEqual(
        (yield* h.tasks).map((task) => [task.owner_id, task.status]),
        [
          ["ada", "running"],
          ["cy", "running"],
        ],
      );
      const note = (yield* h.messages).at(-1)!;
      assert.deepEqual(
        [note.kind, note.author, note.assistant_id, note.text, note.reply_to],
        ["routing", "assistant", "beto", "Beto (lead) routed it to Ada and Cy", posted.message.id],
      );
      const call = h.routeCalls[0] as { groupName: string; request: string; members: unknown[] };
      assert.equal(call.groupName, "Team team:1");
      assert.equal(call.members.length, 3);
      assert.equal(call.request, "Need the budget and a logo");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a routed request keeps its sender in what the member reads", () => {
  const h = harness({ lead: "beto", routable: [claude], route: () => ["ada"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post(
      { teamId: TEAM, text: "Need the budget" },
      { kind: "agent", assistantId: null, label: "Planning chat" },
    );
    yield* groups.idle;
    assert.include(h.sent[0]!.text, "Request from Planning chat (an agent, not the user):");
    yield* groups.post(
      { teamId: TEAM, text: "Weekly numbers" },
      { kind: "routine", label: "Monday" },
    );
    yield* groups.idle;
    assert.include(h.sent[1]!.text, "Scheduled request Monday:");
  }).pipe(Effect.provide(h.layer));
});

it.effect("routing names only the lead's own pick quietly, and counts three names", () => {
  const picks = [["beto"], ["ada", "beto", "cy"]];
  const h = harness({ lead: "beto", routable: [claude], route: () => picks.shift()! });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "lead only" }, h.user);
    yield* groups.idle;
    assert.deepEqual(
      (yield* h.messages).map((row) => row.kind),
      ["message"],
    );
    // With its task done nothing is open, so the next message goes to the lead again.
    yield* h.finish(0, "completed", "Done.");
    yield* groups.post({ teamId: TEAM, text: "everybody" }, h.user);
    yield* groups.idle;
    assert.equal((yield* h.messages).at(-1)!.text, "Beto (lead) routed it to Ada, Beto and Cy");
  }).pipe(Effect.provide(h.layer));
});

const routingMisses: ReadonlyArray<readonly [string, NonNullable<Options["route"]>]> = [
  ["nobody picked", () => []],
  ["only unknown ids", () => ["ghost"]],
  ["the call failed", () => "fail"],
];
it.effect.each(routingMisses)(
  "routing that finds no one pauses a task for the lead: %s",
  ([, route]) => {
    const h = harness({ lead: "beto", routable: [claude], route });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "who knows" }, h.user);
      yield* groups.idle;
      assert.deepEqual(
        (yield* h.tasks).map((task) => [task.owner_id, task.status, task.reason]),
        [["beto", "paused", "routing_failed"]],
      );
      assert.lengthOf(h.sent, 0);
      assert.deepEqual(
        (yield* h.messages).map((row) => row.kind),
        ["message"],
      );
      // The user reassigns it, which starts it.
      const [task] = yield* h.tasks;
      yield* groups.taskAction({
        taskId: task!.task_id as never,
        action: "reassign",
        ownerId: "cy" as never,
      });
      assert.equal(h.sent[0]!.threadId, cyThread);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a group deleted while routing opens nothing", () => {
  const h = harness({ lead: "beto", routable: [claude], route: () => ["ada"] });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* groups.post({ teamId: TEAM, text: "hello" }, h.user);
    yield* groups.idle;
    // A second routing of the same message opens no second task.
    const [message] = yield* h.messages;
    assert.lengthOf(yield* h.tasks, 1);
    yield* sql`DELETE FROM assistant_teams WHERE team_id = ${TEAM}`;
    assert.equal(
      (yield* groups.post({ teamId: TEAM, text: "hello" }, h.user).pipe(Effect.flip)).reason,
      "not_found",
    );
    assert.isDefined(message);
  }).pipe(Effect.provide(h.layer));
});

it.effect("agents post from outside, by id or name, with files, and a repeat posts once", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "group-files-" });
    const file = path.join(dir, "report.txt");
    yield* fs.writeFileString(file, "numbers");
    const first = yield* groups.agentPost({
      callerThreadId: ThreadId.make("thread:outside"),
      group: "team team:1",
      text: "@ada please read this",
      paths: [file],
    });
    assert.deepEqual([first.message.author, first.message.authorLabel], ["agent", "Planning chat"]);
    assert.include(first.message.text, "Files copied to the shared folder for you:");
    assert.include(first.message.text, "report.txt");
    assert.deepEqual(
      first.tasks.map((task) => task.ownerId),
      ["ada"],
    );
    // Nothing new landed, so the same call is the same post.
    const again = yield* groups.agentPost({
      callerThreadId: ThreadId.make("thread:outside"),
      group: TEAM,
      text: "@ada please read this",
      paths: [file],
    });
    assert.equal(again.message.id, first.message.id);
    // An assistant's own conversation posts as that assistant.
    const fromBeto = yield* groups.agentPost({
      callerThreadId: ThreadId.make("assistant:beto:1"),
      group: TEAM,
      text: "@cy hello",
      clientRequestId: "mine",
    });
    assert.deepEqual(
      [fromBeto.message.assistantId, fromBeto.message.authorLabel],
      ["beto", "assistant:beto:1"],
    );
    assert.include(h.sent.at(-1)!.text, "Request from assistant:beto:1 (an agent, not the user):");

    const refuse = (input: Parameters<typeof groups.agentPost>[0]) =>
      groups.agentPost(input).pipe(Effect.flip);
    assert.equal(
      (yield* refuse({ callerThreadId: adaThread, group: TEAM, text: "x" })).message,
      "You are inside a group task: use assign or transfer.",
    );
    assert.equal(
      (yield* refuse({ callerThreadId: ThreadId.make("thread:outside"), group: "none", text: "x" }))
        .reason,
      "not_found",
    );
    assert.equal(
      (yield* refuse({
        callerThreadId: ThreadId.make("thread:outside"),
        group: TEAM,
        text: "@ada x",
        paths: ["relative.txt"],
      })).reason,
      "invalid",
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE assistant_teams SET name = 'Team team:1' WHERE team_id = ${OTHER_TEAM}`;
    assert.equal(
      (yield* refuse({
        callerThreadId: ThreadId.make("thread:outside"),
        group: "team team:1",
        text: "x",
      })).message,
      "Several groups have that name; use the group id.",
    );
  }).pipe(Effect.provide(h.layer), Effect.scoped);
});

it.effect(
  "the chat reads as snapshot then live changes for that group only, and pages back",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      for (let n = 1; n <= 55; n++) {
        yield* sql`INSERT INTO assistant_group_messages
        (message_id, team_id, seq, author, kind, text, created_at)
        VALUES (${`gm:${n}`}, ${TEAM}, ${n}, 'user', 'message', ${`m${n}`}, '2026-01-01')`;
      }
      const pull = yield* Stream.toPull(groups.subscribe(TEAM));
      // The first chunk is the snapshot, which means the subscription is live for what follows.
      const [snapshot] = yield* pull;
      yield* groups.post({ teamId: OTHER_TEAM, text: "@ada elsewhere" }, h.user);
      const posted = yield* groups.post({ teamId: TEAM, text: "@ada here" }, h.user);
      const [message, task] = yield* pull;
      assert.equal(snapshot!.type, "snapshot");
      if (snapshot!.type === "snapshot") {
        assert.equal(snapshot.messages.length, 50);
        assert.equal(snapshot.messages[0]!.seq, 6);
        assert.isTrue(snapshot.hasMore);
      }
      assert.equal(message!.type === "message" ? message.message.id : "", posted.message.id);
      assert.equal(task?.type === "task" ? task.task.teamId : "", TEAM);

      const older = yield* groups.history({ teamId: TEAM, beforeSeq: 6 });
      assert.deepEqual([older.messages.length, older.hasMore], [5, false]);
      assert.equal(
        (yield* groups.history({ teamId: AssistantTeamId.make("nope") }).pipe(Effect.flip)).reason,
        "not_found",
      );
      assert.equal(
        (yield* Stream.runCollect(groups.subscribe(AssistantTeamId.make("nope"))).pipe(Effect.flip))
          .reason,
        "not_found",
      );
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  },
);

it.effect("a member reads older chat in pages, with a very long message cut", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const long = "z".repeat(17_000);
    for (let n = 2; n <= 5; n++) {
      yield* sql`INSERT INTO assistant_group_messages
        (message_id, team_id, seq, author, kind, text, created_at)
        VALUES (${`gm:${n}`}, ${TEAM}, ${n}, 'user', 'message', ${long}, '2026-01-01')`;
    }
    const page = yield* groups.member.history({ callerThreadId: adaThread });
    // 24k characters: one cut message (16k) fits, the next does not.
    assert.deepEqual(
      page.messages.map((message) => message.seq),
      [5],
    );
    assert.isTrue(page.hasMore);
    assert.isAtMost(page.messages[0]!.text.length, 16_001);
    const earlier = yield* groups.member.history({ callerThreadId: adaThread, beforeSeq: 5 });
    assert.deepEqual(
      earlier.messages.map((message) => message.seq),
      [4],
    );
    const small = yield* groups.member.history({ callerThreadId: adaThread, beforeSeq: 2 });
    assert.deepEqual([small.messages.length, small.hasMore], [1, false]);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "the schedule gate posts as a routine once per fire, and fails closed until installed",
  () => {
    const h = harness();
    const gateLayer = Gate.gateLayer;
    return Effect.gen(function* () {
      yield* h.setup;
      const gate = yield* Gate.AssistantGroupGate;
      const input = {
        teamId: TEAM,
        text: "@ada weekly",
        label: "Monday",
        clientRequestId: "fire-1",
      };
      const closed = yield* gate.post(input).pipe(Effect.flip);
      assert.equal(closed.reason, "storage");
      yield* Layer.build(Groups.installLayer);
      yield* gate.post(input);
      yield* gate.post(input);
      const rows = yield* h.messages;
      assert.deepEqual(
        rows.map((row) => [row.author, row.author_label, row.text]),
        [["routine", "Monday", "@ada weekly"]],
      );
      assert.include(h.sent[0]!.text, "Scheduled request Monday:");
      const failing = yield* gate
        .post({ ...input, teamId: "nope", clientRequestId: "x" })
        .pipe(Effect.flip);
      assert.equal(failing.reason, "not_found");
    }).pipe(Effect.provide(Layer.mergeAll(h.layer, gateLayer)), Effect.scoped);
  },
);

it("keeps the thread id stable and distinct per member and group", () => {
  assert.equal(groupThreadId("ada", TEAM), groupThreadId("ada", TEAM));
  assert.notEqual(groupThreadId("ada", TEAM), groupThreadId("ada", OTHER_TEAM));
  assert.notEqual(groupThreadId("ada", TEAM), groupThreadId("beto", TEAM));
});

it.effect(
  "member tools stop in an archived group and refuse questions to oneself or to someone who left",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      yield* groups.post({ teamId: TEAM, text: "@ada @beto prepare" }, h.user);
      yield* h.finish(1, "completed", "Beto's draft");
      const betoAnswer = (yield* h.messages).find((row) => row.assistant_id === "beto")!;
      yield* groups.post({ teamId: TEAM, text: "@cy next" }, h.user);
      const failure = (effect: Effect.Effect<object, AssistantError>) =>
        refusalError(effect).pipe(Effect.map((error) => error.message));
      assert.equal(
        yield* failure(
          groups.member.reply({
            callerThreadId: adaThread,
            messageId: (yield* h.messages).find((row) => row.assistant_id === null)!.message_id,
            text: "?",
          }),
        ),
        "Reply to a message a member wrote in this group.",
      );
      yield* sql`UPDATE assistant_teams SET member_ids_json = '["ada","cy"]' WHERE team_id = ${TEAM}`;
      assert.equal(
        yield* failure(
          groups.member.reply({
            callerThreadId: adaThread,
            messageId: betoAnswer.message_id,
            text: "?",
          }),
        ),
        "That member is no longer in the group.",
      );
      yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = ${TEAM}`;
      assert.equal(
        yield* failure(groups.member.result({ callerThreadId: adaThread, text: "done" })),
        "This group is archived.",
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a member cannot ask itself", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada first" }, h.user);
    yield* h.finish(0, "completed", "Ada's answer");
    const own = (yield* h.messages).find((row) => row.assistant_id === "ada")!;
    yield* groups.post({ teamId: TEAM, text: "@ada again" }, h.user);
    const error = yield* groups.member
      .reply({ callerThreadId: adaThread, messageId: own.message_id, text: "me?" })
      .pipe(Effect.flip);
    assert.equal(error.message, "You cannot ask yourself.");
  }).pipe(Effect.provide(h.layer));
});

const PENDING_IMAGE = "pending-7c9e6679-7425-40de-944b-e07fc1f90ae7-png";
const PENDING_FILE = "pending-8d0f7780-8536-41ef-a55c-f18fd2a01bf8-pdf";
const imageUpload = {
  type: "image",
  id: PENDING_IMAGE,
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;
const fileUpload = {
  type: "file",
  id: PENDING_FILE,
  name: "sheet.pdf",
  mimeType: "application/pdf",
  sizeBytes: 4,
} as const;

/** Stores the bytes a pending upload would hold, where the claim looks for them. */
const storeUploads = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  for (const [upload, bytes] of [
    [imageUpload, "png"],
    [fileUpload, "%PDF"],
  ] as const) {
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: upload,
    })!;
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fileSystem.writeFileString(path, bytes);
  }
  return config.attachmentsDir;
});

it.effect(
  "a message keeps its uploads under the group, and each member that gets the task receives its own copies",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const dir = yield* storeUploads;
      const fileSystem = yield* FileSystem.FileSystem;
      const posted = yield* groups.post(
        { teamId: TEAM, text: "@ada look", attachments: [imageUpload, fileUpload] },
        h.user,
      );
      const stored = posted.message.attachments!;
      assert.deepEqual(
        stored.map((attachment) => [attachment.type, attachment.name]),
        [
          ["image", "shot.png"],
          ["file", "sheet.pdf"],
        ],
      );
      assert.isTrue(stored.every((attachment) => attachment.id.startsWith("group-")));
      // Reading the history back returns the same attachments.
      const history = yield* groups.history({ teamId: TEAM });
      assert.deepEqual(history.messages[0]!.attachments, stored);

      // The task's turn gets images as images and files as files, in the member's own namespace.
      const turn = h.sent[0]!;
      assert.deepEqual(
        turn.attachments.map((attachment) => [attachment.type, attachment.name]),
        [
          ["image", "shot.png"],
          ["file", "sheet.pdf"],
        ],
      );
      assert.isTrue(
        turn.attachments.every((attachment) => attachment.id.startsWith("assistant-ada-")),
      );
      for (const attachment of turn.attachments) {
        const path = resolveAttachmentPath({
          attachmentsDir: dir,
          attachment: attachment as never,
        })!;
        assert.isTrue(yield* fileSystem.exists(path));
        // Cleanup, asset serving and Codex look a file up by its id alone.
        assert.isNotNull(
          resolveAttachmentPathById({ attachmentsDir: dir, attachmentId: attachment.id }),
        );
      }

      // A hand-over starts the same message as Beto's task with copies of its own.
      yield* groups.member.transfer({ callerThreadId: adaThread, member: "beto", note: "yours" });
      yield* h.finish(0, "completed", "handed off");
      const betoTurn = h.sent.find((message) => message.threadId === betoThread)!;
      assert.lengthOf(betoTurn.attachments, 2);
      assert.isTrue(
        betoTurn.attachments.every((attachment) => attachment.id.startsWith("assistant-beto-")),
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("an upload that is not pending, or is gone, refuses the post and stores nothing", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* storeUploads;
    const foreign = yield* groups
      .post(
        {
          teamId: TEAM,
          text: "@ada look",
          attachments: [{ ...imageUpload, id: "thread-1-7c9e6679-7425-40de-944b-e07fc1f90ae7" }],
        },
        h.user,
      )
      .pipe(Effect.flip);
    assert.equal(foreign.reason, "invalid");
    const gone = yield* groups
      .post(
        {
          teamId: TEAM,
          text: "@ada look",
          attachments: [
            imageUpload,
            { ...fileUpload, id: "pending-11111111-2222-4333-8444-555555555555-pdf" },
          ],
        },
        h.user,
      )
      .pipe(Effect.flip);
    assert.equal(gone.reason, "invalid");
    assert.include(gone.message, "sheet.pdf");
    assert.lengthOf(yield* h.messages, 0);
    assert.lengthOf(h.sent, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a file that cannot be copied for the member leaves the others in the task", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const dir = yield* storeUploads;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    yield* groups.post({ teamId: TEAM, text: "@ada two" }, h.user);
    // The third waits for a slot, and its image is lost before it starts.
    const third = yield* groups.post(
      { teamId: TEAM, text: "@ada three", attachments: [imageUpload, fileUpload] },
      h.user,
    );
    yield* fileSystem.remove(
      resolveAttachmentPath({ attachmentsDir: dir, attachment: third.message.attachments![0]! })!,
    );
    yield* h.finish(0, "completed", "one done");
    assert.deepEqual(
      h.sent[2]!.attachments.map((attachment) => attachment.name),
      ["sheet.pdf"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("deleting a group removes the files its messages kept", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* storeUploads;
    const posted = yield* groups.post(
      { teamId: TEAM, text: "@ada look", attachments: [imageUpload] },
      h.user,
    );
    yield* groups.handleAssistantEvent({ type: "teamRemoved", teamId: TEAM } as never);
    assert.deepEqual(h.cleaned, [posted.message.attachments![0]!.id]);
  }).pipe(Effect.provide(h.layer));
});

const setSettings = (instructions: string, memories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE assistant_teams SET instructions = ${instructions},
      memories_json = ${JSON.stringify(memories)} WHERE team_id = ${TEAM}`;
  });

it.effect("every task packet carries the group's instructions and memories", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* setSettings("Answer in Portuguese.", [
      "The fiscal year starts in March",
      "Budget is 5k",
    ]);
    yield* groups.post({ teamId: TEAM, text: "@ada first" }, h.user);
    assert.include(h.sent[0]!.text, "Group instructions:\nAnswer in Portuguese.");
    assert.include(
      h.sent[0]!.text,
      "Group memories:\n- The fiscal year starts in March\n- Budget is 5k",
    );
    yield* setSettings("", []);
    yield* groups.post({ teamId: TEAM, text: "@beto second" }, h.user);
    assert.notInclude(h.sent[1]!.text, "Group instructions:");
    assert.notInclude(h.sent[1]!.text, "Group memories:");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a new conversation keeps the old chat visible but out of news, summary and history",
  () => {
    const h = harness({ summarize: () => "Old summary." });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: bulk("a") }, h.user);
      yield* groups.post({ teamId: TEAM, text: bulk("b") }, h.user);
      yield* groups.idle;
      assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 1);
      yield* h.finish(0, "completed", "ok");
      yield* h.finish(1, "completed", "ok");
      yield* groups.conversation({ teamId: TEAM, action: "new" });
      assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
      const boundary = (yield* h.messages).filter((row) => row.kind === "boundary");
      assert.deepEqual(
        boundary.map((row) => [row.author, row.text]),
        [["user", "new"]],
      );
      const boundarySeq = boundary[0]!.seq;
      yield* groups.post({ teamId: TEAM, text: "@beto after" }, h.user);
      const packet = h.sent.at(-1)!.text;
      assert.notInclude(packet, "Summary of earlier chat");
      assert.notInclude(packet, "aaaa");
      assert.notInclude(packet, "New in the group chat");
      // The old messages stay in the chat, and a member can still ask for them.
      assert.isAbove((yield* groups.history({ teamId: TEAM })).messages.length, 3);
      const fresh = yield* groups.member.history({ callerThreadId: betoThread });
      assert.deepEqual(
        fresh.messages.map((message) => message.seq),
        [boundarySeq + 1],
      );
      const older = yield* groups.member.history({
        callerThreadId: betoThread,
        beforeSeq: boundarySeq + 1,
      });
      assert.isAbove(older.messages.length, 1);
      // The next summary reads only what follows the boundary.
      yield* groups.post({ teamId: TEAM, text: bulk("c") }, h.user);
      yield* groups.post({ teamId: TEAM, text: bulk("d") }, h.user);
      yield* groups.idle;
      const last = h.summaryCalls.at(-1)!;
      assert.isNull(last.previousSummary);
      assert.isTrue(last.messages.every((message) => !message.text.startsWith("@ada aa")));
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a summary still running when a new conversation starts is dropped", () => {
  const gate = Deferred.makeUnsafe<void>();
  const h = harness({ summarize: () => "Stale summary.", summaryGate: gate });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: bulk("a") }, h.user);
    yield* groups.post({ teamId: TEAM, text: bulk("b") }, h.user);
    yield* h.finish(0, "completed", "ok");
    yield* h.finish(1, "completed", "ok");
    yield* groups.conversation({ teamId: TEAM, action: "new" });
    yield* Deferred.succeed(gate, undefined);
    yield* groups.idle;
    assert.lengthOf(h.summaryCalls, 1);
    assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("compact writes a summary now, then draws the boundary", () => {
  const h = harness({ summarize: () => "Compact summary." });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    yield* h.finish(0, "completed", "done one");
    yield* groups.conversation({ teamId: TEAM, action: "compact" });
    assert.lengthOf(h.summaryCalls, 1);
    assert.deepEqual(
      (yield* h.messages).filter((row) => row.kind === "boundary").map((row) => row.text),
      ["compact"],
    );
    yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
    const packet = h.sent.at(-1)!.text;
    assert.include(packet, "Summary of earlier chat:\nCompact summary.");
    assert.notInclude(packet, "done one");
    yield* h.finish(1, "completed", "ok two");
    yield* groups.conversation({ teamId: TEAM, action: "compact" });
    // Nothing new since: nothing to compact.
    const none = yield* groups.conversation({ teamId: TEAM, action: "compact" }).pipe(Effect.flip);
    assert.equal(none.reason, "invalid");
  }).pipe(Effect.provide(h.layer));
});

it.effect("compact without a usable summary draws no boundary", () => {
  const failing = harness({ summarize: () => "fail" });
  const unsupported = harness({ summarize: () => "unsupported" });
  const run = (h: ReturnType<typeof harness>) =>
    Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
      yield* h.finish(0, "completed", "done one");
      const error = yield* groups
        .conversation({ teamId: TEAM, action: "compact" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalid");
      assert.isUndefined((yield* h.messages).find((row) => row.kind === "boundary"));
    }).pipe(Effect.provide(h.layer));
  return Effect.gen(function* () {
    yield* run(failing);
    yield* run(unsupported);
  });
});

it.effect("new, compact and clear wait for the group to stop working", () => {
  const h = harness({ summarize: () => "S." });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada busy" }, h.user);
    for (const action of ["new", "compact", "clear"] as const) {
      const error = yield* groups.conversation({ teamId: TEAM, action }).pipe(Effect.flip);
      assert.equal(error.reason, "invalid");
    }
    assert.lengthOf(yield* h.messages, 1);
    const missing = yield* groups
      .conversation({ teamId: AssistantTeamId.make("nope"), action: "new" })
      .pipe(Effect.flip);
    assert.equal(missing.reason, "not_found");
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "undo removes only a boundary with nothing after it, and no member skips what reuses its number",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
      yield* h.finish(0, "completed", "ok");
      yield* groups.conversation({ teamId: TEAM, action: "new" });
      yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
      const refusal = yield* groups
        .conversation({ teamId: TEAM, action: "undo" })
        .pipe(Effect.flip);
      assert.equal(refusal.reason, "invalid");
      yield* h.finish(1, "completed", "ok two");
      yield* groups.conversation({ teamId: TEAM, action: "new" });
      yield* groups.conversation({ teamId: TEAM, action: "undo" });
      assert.lengthOf(
        (yield* h.messages).filter((row) => row.kind === "boundary"),
        1,
      );
      yield* groups.post({ teamId: TEAM, text: "@ada three" }, h.user);
      assert.include(h.sent.at(-1)!.text, "three");
      const none = yield* groups.conversation({ teamId: TEAM, action: "undo" }).pipe(Effect.flip);
      assert.equal(none.reason, "invalid");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("clear deletes the chat, its tasks, summary and files, and the group starts over", () => {
  const h = harness({ summarize: () => "S." });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* storeUploads;
    const posted = yield* groups.post(
      { teamId: TEAM, text: "@ada look", attachments: [imageUpload] },
      h.user,
    );
    yield* h.finish(0, "completed", "seen");
    yield* groups.conversation({ teamId: TEAM, action: "compact" });
    yield* groups.markRead({ teamId: TEAM });
    yield* groups.conversation({ teamId: TEAM, action: "clear" });
    assert.deepEqual(h.cleaned, [posted.message.attachments![0]!.id]);
    assert.lengthOf(yield* h.messages, 0);
    assert.lengthOf(yield* h.tasks, 0);
    assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
    const [team] = yield* h.sqlRows<{ read_seq: number }>(
      "SELECT read_seq FROM assistant_teams WHERE team_id = 'team:1'",
    );
    assert.equal(team!.read_seq, 0);
    // The member's hidden thread stays, and it takes the next message as new.
    assert.isAbove((yield* h.sqlRows("SELECT * FROM assistant_group_threads")).length, 0);
    yield* groups.post({ teamId: TEAM, text: "@ada again" }, h.user);
    assert.include(h.sent.at(-1)!.text, "again");
    assert.deepEqual(
      (yield* h.messages).map((row) => row.seq),
      [1],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("an agent's change leaves one chat line, never unread and never sent to members", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const say = () =>
      groups.announce({
        teamId: TEAM,
        callerThreadId: ThreadId.make("assistant:ada:1"),
        text: 'renamed the group to "Ops"',
        clientRequestId: "c1",
      });
    yield* say();
    yield* say();
    const lines = (yield* h.messages).filter((row) => row.kind === "change");
    assert.lengthOf(lines, 1);
    assert.equal(lines[0]!.author, "assistant");
    assert.isTrue(lines[0]!.text.endsWith(' renamed the group to "Ops"'));
    const [state] = yield* h.sqlRows<{ unread_count: number }>(
      `SELECT unread_count FROM assistant_team_state WHERE team_id = '${TEAM}'`,
    );
    assert.equal(state!.unread_count, 0);
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    assert.notInclude(h.sent.at(-1)!.text, "renamed the group");
  }).pipe(Effect.provide(h.layer));
});

const assignWith = (
  groups: Groups.AssistantGroups["Service"],
  from: ThreadId,
  member: string,
  instruction: string,
  resources?: ReadonlyArray<string>,
) =>
  groups.member.assign({
    callerThreadId: from,
    member,
    instruction,
    ...(resources === undefined ? {} : { resources }),
  });

it.effect("an assignment keeps its contract and quotes its source messages in the packet", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@beto earlier thing" }, h.user);
    yield* h.finish(0, "completed", "ok");
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const child = yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "beto",
      instruction: "Build it",
      expectedResult: "  the build is green  ",
      sourceSeqs: [1, 1, -3, 99],
      resources: ["Folder: /w/app/", "Browser", "browser", " "],
    });
    const [row] = yield* h.sqlRows<{
      expected_result: string;
      source_seqs_json: string;
      resources_json: string;
    }>(`SELECT * FROM assistant_group_tasks WHERE task_id = '${child.taskId}'`);
    assert.deepEqual(
      [row!.expected_result, row!.source_seqs_json, row!.resources_json],
      ["the build is green", "[1,99]", '["folder:/w/app","browser"]'],
    );
    const packet = h.sent.at(-1)!.text;
    assert.include(packet, "Earlier messages this task refers to:\n[#1 user] @beto earlier thing");
    assert.include(packet, "Expected result: the build is green");
    assert.include(packet, "folder:/w/app, browser");
    // A repeat lands on the same task.
    const repeat = yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "beto",
      instruction: "Build it",
      resources: ["browser"],
    });
    assert.equal(repeat.taskId, child.taskId);
  }).pipe(Effect.provide(h.layer));
});

it.effect("tasks sharing a resource run one after another, oldest first", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* assignWith(groups, adaThread, "beto", "A", ["folder:/w/app"]);
    yield* assignWith(groups, adaThread, "cy", "B", ["folder:/w/app/src"]);
    yield* assignWith(groups, adaThread, "beto", "C", ["folder:/w/app"]);
    yield* assignWith(groups, adaThread, "cy", "D", ["folder:/w/other"]);
    const view = () =>
      h.tasks.pipe(
        Effect.map((rows) =>
          rows.slice(1).map((row) => `${row.owner_id}:${row.status}:${row.reason}`),
        ),
      );
    assert.deepEqual(yield* view(), [
      "beto:running:null",
      "cy:queued:waiting for folder:/w/app/src (used by Beto)",
      "beto:queued:waiting for folder:/w/app (used by Beto)",
      "cy:queued:null",
    ]);
    // Ada ends her run (waiting on her children): the free slot goes to D, not to the blocked ones.
    yield* h.finish(0, "completed", "waiting");
    assert.deepEqual(yield* view(), [
      "beto:running:null",
      "cy:queued:waiting for folder:/w/app/src (used by Beto)",
      "beto:queued:waiting for folder:/w/app (used by Beto)",
      "cy:running:null",
    ]);
    // A finishes: B (older) takes the folder and C now waits on it.
    yield* h.finish(1, "completed", "a done");
    assert.deepEqual(yield* view(), [
      "beto:completed:null",
      "cy:running:null",
      "beto:queued:waiting for folder:/w/app (used by Cy)",
      "cy:running:null",
    ]);
    yield* h.finish(2, "completed", "d done");
    assert.deepEqual(yield* view(), [
      "beto:completed:null",
      "cy:running:null",
      "beto:queued:waiting for folder:/w/app (used by Cy)",
      "cy:completed:null",
    ]);
    // B failing releases the folder to C.
    yield* h.finish(3, "failed");
    assert.deepEqual((yield* view()).slice(1, 3), ["cy:failed:failed", "beto:running:null"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a child waiting on a resource its parent holds starts when the parent's run ends",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
      yield* assignWith(groups, adaThread, "beto", "Part", ["browser"]);
      const grandchild = yield* assignWith(groups, betoThread, "cy", "Sub", ["browser"]);
      assert.equal(grandchild.status, "queued");
      yield* h.finish(0, "completed", "waiting");
      assert.equal((yield* h.tasks)[2]!.status, "queued");
      // Beto waits on his child without holding the browser, so the child runs: no deadlock.
      yield* h.finish(1, "completed", "waiting");
      assert.deepEqual(statusesOf(yield* h.tasks), ["ada:waiting", "beto:waiting", "cy:running"]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a member cancels only what it assigned, and a repeat changes nothing more", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const held = yield* assignWith(groups, adaThread, "beto", "A", ["browser"]);
    const waiter = yield* assignWith(groups, adaThread, "cy", "B", ["browser"]);
    const [root] = yield* h.tasks;
    for (const taskId of [held.taskId, root!.task_id, "gt:none"]) {
      const refused = yield* refusalError(
        groups.member.cancel({ callerThreadId: betoThread, taskId, reason: "no" }),
      );
      assert.equal(refused.message, "You can only cancel a task you assigned.");
    }
    const asked = yield* groups.member.cancel({
      callerThreadId: adaThread,
      taskId: held.taskId,
      reason: "the user said stop",
    });
    assert.deepEqual(asked, { accepted: true, message: "Cancelled." });
    const rows = yield* h.tasks;
    assert.deepEqual(
      [rows[1]!.status, rows[1]!.reason, rows[2]!.status, rows[2]!.reason],
      ["cancelled", "the user said stop", "running", null],
    );
    const interrupts = () =>
      h.dispatched.filter((command) => command.type === "run.interrupt").map((c) => c.threadId);
    assert.deepEqual(interrupts(), [betoThread]);
    const again = yield* groups.member.cancel({
      callerThreadId: adaThread,
      taskId: held.taskId,
      reason: "again",
    });
    assert.deepEqual(again, { accepted: true, message: "Already cancelled." });
    assert.deepEqual(interrupts(), [betoThread]);
    assert.equal(waiter.status, "queued");
    // The interruption that follows changes nothing: the task was already cancelled.
    yield* h.finish(1, "interrupted");
    assert.equal((yield* h.tasks)[1]!.status, "cancelled");
    // A completed task cannot be cancelled.
    yield* h.finish(2, "completed", "B done");
    const late = yield* groups.member.cancel({
      callerThreadId: adaThread,
      taskId: waiter.taskId,
      reason: "",
    });
    assert.deepEqual(late, { accepted: false, message: "That task is already completed." });
  }).pipe(Effect.provide(h.layer));
});

it.effect("a packet lists the member's stopped and failed tasks, newest first and capped", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, created_at)
      VALUES ('gm:old', ${TEAM}, 1, 'user', 'message', 'old', '2026-01-01')`;
    for (let index = 0; index < 7; index += 1) {
      yield* sql`INSERT INTO assistant_group_tasks
        (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status, reason,
         revision, hops, created_at, updated_at)
        VALUES (${`gt:s${index}`}, ${TEAM}, ${`gt:s${index}`}, 'root', 'gm:old', 'ada',
          ${`stopped job ${index} ${"x".repeat(200)}`}, ${index === 6 ? "failed" : "paused"},
          ${index === 6 ? "failed" : "stopped"}, 1, 0, '2026-01-01', ${`2026-01-0${index + 1}`})`;
    }
    yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
       revision, hops, created_at, updated_at)
      VALUES ('gt:other', ${TEAM}, 'gt:other', 'root', 'gm:old', 'beto', 'not hers', 'paused', 1, 0,
        '2026-01-01', '2026-01-09')`;
    yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction, status,
       revision, hops, created_at, updated_at)
      VALUES ('gt:kid', ${TEAM}, 'gt:s0', 'gt:s0', 'child', 'gm:old', 'beto', 'price the plan',
        'running', 1, 0, '2026-01-01', '2026-01-01')`;
    yield* groups.post({ teamId: TEAM, text: "@ada next" }, h.user);
    const packet = h.sent[0]!.text;
    assert.include(
      packet,
      "Subtasks you gave that are still open (t3_group cancel stops one):\n- gt:kid (running, Beto): price the plan",
    );
    const listed = packet.split("\n").filter((line) => line.startsWith("- gt:s"));
    assert.lengthOf(listed, 5);
    assert.include(packet, "Your stopped tasks in this group");
    assert.match(listed[0]!, /^- gt:s6 \(failed, failed\): stopped job 6 x+…$/);
    assert.match(listed[4]!, /^- gt:s2 \(paused, stopped\)/);
    assert.notInclude(packet, "not hers");
  }).pipe(Effect.provide(h.layer));
});

it.effect("routineScope says who wrote the request a member's task came from", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada plan the launch" }, h.user);
    const user = yield* groups.member.routineScope({ callerThreadId: adaThread });
    assert.deepEqual(user, { teamId: TEAM, askedByUser: true });
    // A task handed on from the user's request still counts as the user's ask.
    yield* groups.member.assign({
      callerThreadId: adaThread,
      member: "beto",
      instruction: "Build",
    });
    assert.equal(
      (yield* groups.member.routineScope({ callerThreadId: betoThread })).askedByUser,
      true,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a task that a schedule's post opened is not the user's ask", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post(
      { teamId: TEAM, text: "@ada weekly report" },
      { kind: "routine", label: "Monday report" },
    );
    const scope = yield* groups.member.routineScope({ callerThreadId: adaThread });
    assert.deepEqual(scope, { teamId: TEAM, askedByUser: false });
  }).pipe(Effect.provide(h.layer));
});

it.effect("a routine change line is muted, authored by the schedule, and added once", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const line = {
      teamId: TEAM as never,
      label: "Monday",
      text: "Paused routine 'Monday'",
      clientRequestId: "routine-note:t:off:1",
    };
    yield* groups.announceRoutine(line);
    yield* groups.announceRoutine(line);
    const rows = yield* h.messages;
    assert.deepEqual(
      rows.map((row) => [row.author, row.author_label, row.kind, row.text]),
      [["routine", "Monday", "change", "Paused routine 'Monday'"]],
    );
    assert.equal(h.sent.length, 0);
    const missing = yield* groups
      .announceRoutine({ ...line, teamId: "nope" as never })
      .pipe(Effect.flip);
    assert.equal(missing.reason, "not_found");
  }).pipe(Effect.provide(h.layer));
});
