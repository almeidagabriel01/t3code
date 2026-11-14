import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION,
  ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY,
  ASSISTANT_GROUP_REPLY_MAX_CHARS,
  type AssistantError,
  AssistantId,
  type AssistantsEvent,
  AssistantTeamId,
  type AssistantGroupMessageId,
  type AssistantGroupTask,
  type AssistantGroupTaskAction,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectModelSelection from "../orchestration-v2/ProjectModelSelectionService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as Gate from "./AssistantGroupGate.ts";
import * as Directory from "./AssistantDirectory.ts";
import * as Groups from "./AssistantGroups.ts";
import {
  groupThreadId,
  HANDOFF_PAUSES,
  requestThreadId,
  taskMessageId,
} from "./AssistantGroups.ts";
import { AssistantService } from "./AssistantService.ts";

class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

const refusalError = (effect: Effect.Effect<object, AssistantError>) => Effect.flip(effect);

const TEAM = AssistantTeamId.make("team:1");
const OTHER_TEAM = AssistantTeamId.make("team:2");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const p1 = ProjectId.make("p1");
const p2 = ProjectId.make("p2");
const selection = (instanceId: ProviderInstanceId, model = "m"): ModelSelection => ({
  instanceId,
  model,
});

interface FakeThread {
  projectId: string;
  title: string;
  archivedAt: string | null;
  deletedAt: string | null;
  settledOverride: "settled" | null;
  modelSelection: ModelSelection;
}
interface FakeRun {
  id: string;
  userMessageId: string;
  status: string;
  ordinal?: number;
  completedAt?: DateTime.Utc;
  usageLimitContinuationOfRunId?: string;
}

interface Options {
  /** Members of the first team, in order. */
  readonly members?: ReadonlyArray<string>;
  /** More assistants beside Ada, Beto and Cy, each named after its id. */
  readonly assistants?: ReadonlyArray<string>;
  readonly lead?: string | null;
  /** Provider instances whose text generation offers routing. */
  readonly routable?: ReadonlyArray<ProviderInstanceId>;
  /** What the summary call answers; "fail" errors it and "unsupported" leaves the operation out. */
  readonly summarize?: (call: number) => string | "fail" | "unsupported";
  /** Holds every summary call until it completes. */
  readonly summaryGate?: Deferred.Deferred<void>;
  /** The server's auto-resume setting for usage-limited threads; on unless set. */
  readonly autoResume?: boolean;
  readonly route?: (input: {
    readonly members: ReadonlyArray<{ readonly id: string }>;
    readonly projects?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly request: string;
  }) =>
    | ReadonlyArray<string>
    | "fail"
    | "none"
    | {
        readonly assistantIds: ReadonlyArray<string>;
        readonly projectId?: string;
        readonly question?: string;
        readonly title?: string;
      };
  /** Projects each member may work in (by assistant id); the rest work anywhere from p1. */
  readonly projects?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Server settings beside auto-resume, such as each project's default model. */
  readonly settings?: DeepPartial<ServerSettingsValue>;
}

/** Titles of the projects tests use; each exists in the projection. */
const PROJECT_TITLES: Readonly<Record<string, string>> = {
  p1: "Core",
  p2: "Mobile App",
  p3: "Site",
};

const harness = (options: Options = {}) => {
  const fakeThreads = new Map<string, FakeThread>();
  const runs = new Map<string, FakeRun[]>();
  const answers = new Map<string, string>();
  /** Runs that failed on a usage limit, with the limit's reset time. */
  const limits = new Map<string, string>();
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
  /** What the projection answers for a runtime request, by id. */
  const runtimeRequests = new Map<string, { request: unknown; item: unknown }>();
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
      settledOverride: null,
      modelSelection: model,
    });
  addThread("assistant:ada:1", "p1", selection(codex, "ada-model"));
  addThread("assistant:beto:1", "p1", selection(claude, "beto-model"));
  addThread("assistant:cy:1", "p1", selection(codex, "cy-model"));
  addThread("thread:outside", "p1", selection(codex), "Planning chat");
  for (const id of options.assistants ?? []) addThread(`assistant:${id}:1`, "p1", selection(codex));

  const mocks = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.empty,
      getThreadRecords: ((threadId: string, _fields: unknown, filter?: Record<string, unknown>) => {
        const statuses = filter?.runStatuses as ReadonlyArray<string> | undefined;
        const runIds = filter?.messageRunIds as ReadonlyArray<string> | undefined;
        const errorRunIds = filter?.turnItemRunIds as ReadonlyArray<string> | undefined;
        return Effect.succeed({
          turnItems: (errorRunIds ?? []).flatMap((runId) =>
            limits.has(runId)
              ? [
                  {
                    type: "error",
                    status: "failed",
                    runId,
                    failure: { class: "usage_limit", resetAt: limits.get(runId) },
                  },
                ]
              : [],
          ),
          runs: (runs.get(threadId) ?? []).filter(
            (run) => statuses === undefined || statuses.includes(run.status),
          ),
          messages: (runIds ?? []).flatMap((runId) =>
            answers.has(runId) ? [{ role: "assistant", text: answers.get(runId) }] : [],
          ),
        });
      }) as never,
      dispatch: ((command: {
        type: string;
        threadId: string;
        commandId: string;
        runId?: string;
        modelSelection?: ModelSelection;
      }) => {
        // Like the Orchestrator: another provider waits until the thread's turn has ended.
        if (command.type === "thread.model-selection.set") {
          const thread = fakeThreads.get(command.threadId)!;
          const busy = (runs.get(command.threadId) ?? []).some((run) =>
            ["running", "waiting"].includes(run.status),
          );
          if (busy && thread.modelSelection.instanceId !== command.modelSelection!.instanceId) {
            return Effect.fail(
              new Orchestrator.OrchestratorProviderSelectionBusyError({
                commandId: command.commandId as never,
                threadId: command.threadId as never,
              }),
            );
          }
          thread.modelSelection = command.modelSelection!;
        }
        return Effect.sync(() => {
          dispatched.push(command);
          const thread = fakeThreads.get(command.threadId);
          if (thread !== undefined) {
            if (command.type === "thread.archive") thread.archivedAt = "now";
            if (command.type === "thread.unarchive") thread.archivedAt = null;
            if (command.type === "thread.delete") thread.deletedAt = "now";
            if (command.type === "thread.unsettle") thread.settledOverride = null;
            if (command.type === "thread.metadata.update")
              thread.title = (command as { title?: string }).title ?? thread.title;
          }
          return {} as never;
        });
      }) as never,
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRuntimeResponseContext: ((_threadId: string, requestId: string) =>
        Effect.succeed({
          request: runtimeRequests.get(requestId)?.request,
          item: runtimeRequests.get(requestId)?.item,
          node: undefined,
          session: undefined,
        })) as never,
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: ((threadId: string) => {
        const thread = fakeThreads.get(threadId);
        return thread === undefined ? Effect.fail(new Boom()) : Effect.succeed({ thread });
      }) as never,
      // Like the Orchestrator: a thread with a live run refuses to settle.
      settleThread: ((input: { threadId: string; commandId: string }) => {
        const thread = fakeThreads.get(input.threadId);
        const live = (runs.get(input.threadId) ?? []).some((run) =>
          ["queued", "running"].includes(run.status),
        );
        if (thread === undefined || live) return Effect.fail(new Boom());
        thread.settledOverride = "settled";
        dispatched.push({ type: "thread.settle", ...input });
        return Effect.succeed({ sequence: 1 });
      }) as never,
      sendToThread: ((input: (typeof sent)[number]) => {
        if (state.failSend) return Effect.fail(new Boom());
        sent.push(input);
        // A message to a settled thread makes it active again.
        const target = fakeThreads.get(input.threadId);
        if (target !== undefined) target.settledOverride = null;
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
        // Like the Orchestrator: an id that exists, deleted or not, cannot be launched again.
        if (fakeThreads.has(input.threadId)) return Effect.fail(new Boom());
        launched.push(input);
        addThread(input.threadId, input.projectId, input.modelSelection, input.title);
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
      routeAssistantGroup: ((input: Parameters<NonNullable<Options["route"]>>[0]) => {
        routeCalls.push(input);
        const picked = options.route?.(input) ?? [];
        return picked === "fail"
          ? Effect.fail(new Boom())
          : picked === "none"
            ? Effect.succeed({ assistantIds: [], noReply: true })
            : Effect.succeed("assistantIds" in picked ? picked : { assistantIds: picked });
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
    Layer.mock(DocumentText.DocumentText)({ ensure: () => Effect.undefined }),
    Directory.layer,
    Layer.succeed(ResourceCleanupService.ResourceCleanupService, {
      cleanupScheduledTasks: () => Effect.void,
      cleanupTerminals: () => Effect.void,
      cleanupPreviews: () => Effect.void,
      cleanupAttachments: (ids) => Effect.sync(() => void cleaned.push(...ids)),
    }),
    ProjectModelSelection.layer.pipe(
      Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone })),
    ),
  ).pipe(
    Layer.provideMerge(
      ServerSettings.layerTest({
        ...options.settings,
        autoResumeLimitedThreads: options.autoResume ?? true,
      }),
    ),
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
    for (const [id, title] of Object.entries(PROJECT_TITLES)) {
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${id}, ${title}, ${`/work/${id}`}, '[]', '2026-01-01', '2026-01-01')`;
    }
    const assistant = (id: string, name: string, role: string, access = "workspace-write") => {
      const listed = options.projects?.[id] ?? [];
      return sql`INSERT INTO assistants
        (assistant_id, handle, name, project_id, instructions, tool_access, thread_id, role,
          scope, project_ids_json, created_at, updated_at)
        VALUES (${id}, ${id}, ${name}, ${listed[0] ?? "p1"}, ${`${name} does ${role}.`}, ${access},
          ${`assistant:${id}:1`}, ${role}, ${listed.length === 0 ? "all" : "project"},
          ${listed.length === 0 ? null : JSON.stringify(listed)}, '2026-01-01', '2026-01-01')`;
    };
    yield* assistant("ada", "Ada", "CFO", "read-only");
    yield* assistant("beto", "Beto", "Engineering");
    yield* assistant("cy", "Cy", "Design");
    for (const id of options.assistants ?? []) yield* assistant(id, id, "Member");
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
    instruction: string;
    status: string;
    reason: string | null;
    revision: number;
    kind: string;
    hops: number;
    undelivered_hops: number;
    root_id: string;
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

  /** Ends the live run of a task's current revision. */
  const finishTask = (taskId: string, status: string, answer?: string) =>
    Effect.gen(function* () {
      const task = (yield* tasks).find((row) => row.task_id === taskId)!;
      const messageId = taskMessageId(task.task_id, task.revision);
      yield* finish(
        sent.findIndex((row) => row.messageId === messageId),
        status,
        answer,
      );
    });

  /** The thread a member's newest task was sent to: the member tools' caller. */
  const threadOf = (member: string) =>
    ThreadId.make(
      sent.findLast((row) => row.threadId.startsWith(`assistant:${member}:g-`))?.threadId ??
        groupThreadId(member, TEAM),
    );

  return {
    layer,
    setup,
    threadOf,
    user,
    sent,
    dispatched,
    launched,
    fakeThreads,
    runs,
    limits,
    answers,
    runtimeRequests,
    live,
    deletedTeams,
    refreshed,
    cleaned,
    routeCalls,
    summaryCalls,
    state,
    finish,
    finishTask,
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
    assert.equal(posted.tasks[0]!.threadId, h.threadOf("ada"));
    assert.deepEqual(
      h.sent.map((message) => message.threadId),
      [h.threadOf("ada"), h.threadOf("beto")],
    );
    // The first free slot goes to the oldest queued task.
    yield* h.finish(0, "completed", "Books closed.");
    assert.equal(h.sent.length, 3);
    assert.equal(h.sent[2]!.threadId, h.threadOf("cy"));
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
    // A reply to something that is not a member's answer still continues the request: the one
    // member working it takes it.
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
    assert.equal(posted.message.requestId, (yield* h.messages)[0]!.message_id);
    // Nothing is stopped now: it is a new request, and with no lead it waits.
    const next = yield* groups.post({ teamId: TEAM, text: "continue" }, h.user);
    assert.deepEqual(next.tasks, []);
    assert.equal(next.message.requestId, next.message.id);
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a message replying to nothing starts a request the lead routes; a reply continues its request",
  () => {
    const h = harness({ lead: "beto", routable: [claude], route: () => ["cy"] });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const budget = yield* groups.post({ teamId: TEAM, text: "@ada the budget" }, h.user);
      // While Ada works, an unrelated message is its own request, not a follow-up of hers.
      const other = yield* groups.post({ teamId: TEAM, text: "include Q3 too" }, h.user);
      yield* groups.idle;
      assert.lengthOf(h.routeCalls, 1);
      assert.equal(other.message.requestId, other.message.id);
      // Replying to the budget request keeps it there, with the member working it.
      const reply = yield* groups.post(
        { teamId: TEAM, text: "include Q3 too", replyToMessageId: budget.message.id },
        h.user,
      );
      assert.equal(reply.message.requestId, budget.message.id);
      assert.deepEqual(
        reply.tasks.map((task) => [task.ownerId as string, task.requestId as string]),
        [["ada", budget.message.id]],
      );
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
      assert.lengthOf(h.launched, 1);
      assert.notInclude(
        h.dispatched.map((command) => command.type),
        "thread.model-selection.set",
      );
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

it.effect(
  "a member gets one thread per request, launched lazily in its project on that project's model",
  () => {
    const h = harness({
      projects: { ada: ["p1", "p2"] },
      settings: {
        projectSettingsOverrides: {
          [p1]: { defaultModelSelection: selection(codex, "p1-model") },
          [p2]: { defaultModelSelection: selection(claude, "p2-model") },
        },
      },
    });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const one = yield* groups.post({ teamId: TEAM, text: "@ada one", projectId: p1 }, h.user);
      // Ada's own conversation is not the group's model: each request follows its project.
      h.fakeThreads.get("assistant:ada:1")!.modelSelection = selection(claude, "ada-new");
      const two = yield* groups.post({ teamId: TEAM, text: "@ada two", projectId: p2 }, h.user);
      assert.deepEqual(
        h.launched.map((input) => [input.projectId, input.modelSelection]),
        [
          ["p1", selection(codex, "p1-model")],
          ["p2", selection(claude, "p2-model")],
        ],
      );
      // Later tasks run on what the thread has, so a change made in it stays.
      assert.deepEqual(
        h.sent.map((input) => input.modelSelection),
        [undefined, undefined],
      );
      const first = requestThreadId("ada", TEAM, one.message.id);
      const second = requestThreadId("ada", TEAM, two.message.id);
      assert.notEqual(first, second);
      assert.deepEqual(
        h.launched.map((input) => input.threadId),
        [first, second],
      );
      assert.deepInclude(h.launched[0], {
        commandId: `assistant-group-launch:${first}`,
        threadId: first,
        projectId: "p1",
        title: "Ada · Team team:1 · one",
        // Ada is read-only, so the thread asks before acting.
        runtimeMode: "approval-required",
        generateTitle: false,
        createdBy: "system",
      });
      assert.match(first, /^assistant:ada:g-[0-9a-f]{16}$/);
      // More work for Ada in the first request continues her conversation for it.
      yield* h.finish(0, "completed", "Done one.");
      yield* groups.post(
        { teamId: TEAM, text: "and the totals", replyToMessageId: one.message.id },
        h.user,
      );
      assert.equal(h.sent.at(-1)!.threadId, first);
      assert.lengthOf(h.launched, 2);
      assert.deepEqual(
        (yield* h.sqlRows<{ request_id: string; thread_id: string }>(
          "SELECT request_id, thread_id FROM assistant_group_request_threads ORDER BY rowid",
        )).map((row) => [row.request_id, row.thread_id]),
        [
          [one.message.id, first],
          [two.message.id, second],
        ],
      );
      assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_threads"), 0);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a request given its project later moves its threads to that project's model once each is free",
  () => {
    const h = harness({
      projects: { ada: ["p1", "p2"] },
      settings: {
        projectSettingsOverrides: {
          [p1]: { defaultModelSelection: selection(codex, "p1-model") },
          [p2]: { defaultModelSelection: selection(claude, "p2-model") },
        },
      },
    });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      const one = yield* groups.post(
        { teamId: TEAM, text: "@ada @beto one", projectId: p1 },
        h.user,
      );
      // As a request from before requests had projects: started, with none.
      yield* sql`UPDATE assistant_group_messages SET project_id = NULL WHERE message_id = ${one.message.id}`;
      const ada = requestThreadId("ada", TEAM, one.message.id);
      const beto = requestThreadId("beto", TEAM, one.message.id);
      // Beto picked another model in his thread: that choice stays.
      h.fakeThreads.get(beto)!.modelSelection = selection(codex, "beto-pick");
      const switches = () =>
        h.dispatched.filter((command) => command.type === "thread.model-selection.set");

      yield* groups.post(
        { teamId: TEAM, text: "this is for p2", replyToMessageId: one.message.id, projectId: p2 },
        h.user,
      );
      // Ada's turn is still running, so her provider changes when it ends.
      assert.lengthOf(switches(), 0);
      yield* h.finish(0, "completed", "done");
      yield* h.finish(1, "completed", "done");
      assert.deepEqual(
        switches().map((command) => command.threadId),
        [ada],
      );
      assert.deepEqual(h.fakeThreads.get(ada)!.modelSelection, selection(claude, "p2-model"));
      assert.deepEqual(h.fakeThreads.get(beto)!.modelSelection, selection(codex, "beto-pick"));
      assert.lengthOf(h.launched, 2);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a task that cannot start fails with a reason the user can see", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    h.state.failLaunch = true;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    h.state.failLaunch = false;
    h.state.failSend = true;
    yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.status, task.reason]),
      [
        ["failed", "thread_unavailable"],
        ["failed", "could_not_start"],
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a member whose request thread is gone gets a new one and its tasks run", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const request = yield* groups.post({ teamId: TEAM, text: "@ada one @beto one" }, h.user);
    yield* h.finish(0, "completed", "ok");
    yield* h.finish(1, "completed", "ok");
    const threadOf = (assistantId: string) =>
      h
        .sqlRows<{ thread_id: string; seen_seq: number }>(
          `SELECT thread_id, seen_seq FROM assistant_group_request_threads WHERE assistant_id = '${assistantId}'`,
        )
        .pipe(Effect.map((rows) => rows[0]!));
    const adaFirst = h.threadOf("ada");
    const betoFirst = h.threadOf("beto");
    const more = (text: string) =>
      groups.post({ teamId: TEAM, text, replyToMessageId: request.message.id }, h.user);

    // Deleted (its project was deleted): the id stays reserved, so the member moves to a new one.
    h.fakeThreads.get(betoFirst)!.deletedAt = "now";
    h.state.failLaunch = true;
    const stuck = yield* more("@beto two @ada two");
    assert.deepEqual(
      (yield* h.tasks).slice(2).map((task) => [task.owner_id, task.status, task.reason]),
      [
        ["beto", "failed", "thread_unavailable"],
        ["ada", "running", null],
      ],
    );
    h.state.failLaunch = false;
    const failedId = stuck.tasks.find((task) => task.ownerId === "beto")!.id;
    const resumed = yield* groups.taskAction({ taskId: failedId, action: "resume" });
    const moved = (yield* threadOf("beto")).thread_id;
    assert.notEqual(moved, betoFirst);
    assert.match(moved, /^assistant:beto:g-[0-9a-f]{16}$/);
    assert.deepEqual([resumed.status, resumed.threadId], ["running", moved]);
    assert.equal(h.sent.at(-1)!.threadId, moved);
    // The new thread has seen nothing, so its first packet carries the request again.
    assert.include(h.sent.at(-1)!.text, "@ada one @beto one");
    assert.deepEqual(
      h.launched.map((input) => input.threadId),
      [adaFirst, betoFirst, moved],
    );

    // Absent (rows copied without their threads): no tombstone, so the same id launches again,
    // under another command id since the first one's receipt may still be stored.
    h.fakeThreads.delete(adaFirst);
    for (const index of [2, 3]) yield* h.finish(index, "completed", "ok");
    yield* more("@ada three");
    assert.equal((yield* threadOf("ada")).thread_id, adaFirst);
    assert.equal(h.launched.at(-1)!.threadId, adaFirst);
    assert.notEqual(h.launched.at(-1)!.commandId, h.launched[0]!.commandId);
    assert.deepEqual(
      (yield* h.tasks).filter((task) => task.owner_id === "ada").map((task) => task.status),
      ["completed", "completed", "running"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("the packet carries what the member has not seen of its request, once", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const first = yield* groups.post({ teamId: TEAM, text: "@ada @beto first" }, h.user);
    const packet = h.sent[0]!.text;
    assert.include(packet, `<t3_group_task group="Team team:1" task="`);
    assert.include(packet, 'kind="root">');
    assert.include(packet, 'You are Ada (@ada) in the group "Team team:1".');
    assert.include(
      packet,
      "Members: Ada (@ada, CFO), Beto (@beto, Engineering), Cy (@cy, Design).",
    );
    assert.include(packet, 'This task belongs to the request "first".');
    assert.include(packet, "Your task, from the user: @ada @beto first");
    // The request is the task, so it is not repeated as news.
    assert.notInclude(packet, "New in this request");
    yield* h.finish(0, "completed", "ok one");
    yield* h.finish(1, "completed", "beto says hi");
    yield* groups.post({ teamId: TEAM, text: "@cy second" }, h.user);
    yield* groups.post(
      { teamId: TEAM, text: "@ada third", replyToMessageId: first.message.id },
      h.user,
    );
    const next = h.sent.at(-1)!.text;
    // Ada's own answer is already in her thread; Beto's answer in the request is news to her, and
    // another request never reaches her.
    assert.include(next, "New in this request since your last task:");
    assert.include(next, "beto says hi");
    assert.notInclude(next, "ok one");
    assert.notInclude(next, "second");
    yield* h.finishTask((yield* h.tasks).at(-1)!.task_id, "completed", "ok three");
    yield* groups.post(
      { teamId: TEAM, text: "@ada fourth", replyToMessageId: first.message.id },
      h.user,
    );
    assert.notInclude(h.sent.at(-1)!.text, "beto says hi");
  }).pipe(Effect.provide(h.layer));
});

it.effect("a task also carries its request's older messages it names by #seq or replies to", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const budget = yield* groups.post({ teamId: TEAM, text: "@ada the budget is 5k" }, h.user);
    yield* h.finish(0, "completed", "noted");
    yield* groups.post({ teamId: TEAM, text: "@beto unrelated" }, h.user);
    const more = (text: string, replyTo: string) =>
      groups.post({ teamId: TEAM, text, replyToMessageId: replyTo as never }, h.user);
    yield* more("@ada what about #1, #3 and #99?", budget.message.id);
    const packet = h.sent.at(-1)!.text;
    assert.include(
      packet,
      "Earlier messages this task refers to:\n[#1 user] @ada the budget is 5k",
    );
    // #3 is another request's message: naming it does not bring it in.
    assert.notInclude(packet, "unrelated");
    assert.notInclude(packet, "#99 ");
    yield* h.finishTask((yield* h.tasks).at(-1)!.task_id, "completed", "yes");
    const question = (yield* h.messages).find((row) => row.text.startsWith("@ada what about"))!;
    yield* more("@ada and this?", question.message_id);
    assert.include(h.sent.at(-1)!.text, "[#4 user] @ada what about #1");
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
      yield* groups.member.result({ callerThreadId: h.threadOf("ada"), text: result });
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

it.effect("a usage limit holds the task until its thread continues it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const adaThread = h.threadOf("ada");
    const resetAt = "2026-01-01T12:00:00.000Z";
    const [limitedRun] = h.runs.get(adaThread)!;
    Object.assign(limitedRun!, { ordinal: 1, completedAt: DateTime.makeUnsafe(0) });
    h.limits.set(limitedRun!.id, resetAt);
    yield* h.finish(0, "failed");
    const page = () =>
      groups
        .history({ teamId: TEAM })
        .pipe(
          Effect.map(({ tasks }) => tasks.map((task) => [task.status, task.resetAt, task.reason])),
        );
    assert.deepEqual(yield* page(), [["usage_limited", resetAt, null]]);
    assert.lengthOf(
      (yield* h.messages).filter((row) => row.author === "assistant"),
      0,
    );

    // The thread continues the limited run at the reset, on its own message.
    const continuation = {
      id: "run:continuation",
      threadId: adaThread,
      userMessageId: "limit-resume:x",
      usageLimitContinuationOfRunId: limitedRun!.id,
      ordinal: 2,
      status: "running",
    };
    h.runs.get(adaThread)!.push(continuation);
    const update = () =>
      groups.handleRunEvent({ type: "run.updated", payload: continuation } as never);
    yield* update();
    assert.deepEqual(yield* page(), [["running", undefined, null]]);
    continuation.status = "completed";
    yield* update();
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:completed"]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a member at a usage limit starts no other task until the limited one continues", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const [one] = [
      yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user),
      yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user),
      yield* groups.post({ teamId: TEAM, text: "@ada three" }, h.user),
    ];
    const adaThread = requestThreadId("ada", TEAM, one.message.id);
    const [limitedRun] = h.runs.get(adaThread)!;
    Object.assign(limitedRun!, { ordinal: 1, completedAt: DateTime.makeUnsafe(0) });
    h.limits.set(limitedRun!.id, "2026-01-01T12:00:00.000Z");
    yield* h.finish(0, "failed");
    // The limited task frees its slot, but its thread is not free for Ada's next task.
    yield* h.finish(1, "completed", "two done");
    assert.lengthOf(h.sent, 2);
    assert.deepEqual(
      (yield* h.tasks).map((task) => `${task.owner_id}:${task.status}:${task.reason}`),
      [
        "ada:usage_limited:2026-01-01T12:00:00.000Z",
        "beto:completed:null",
        "ada:queued:waiting for a usage limit",
      ],
    );

    // The continuation still ends the limited task, and then the next one starts.
    const continuation = {
      id: "run:continuation",
      threadId: adaThread,
      userMessageId: "limit-resume:x",
      usageLimitContinuationOfRunId: limitedRun!.id,
      ordinal: 2,
      status: "completed",
    };
    h.runs.get(adaThread)!.push(continuation);
    yield* groups.handleRunEvent({ type: "run.updated", payload: continuation } as never);
    assert.deepEqual(statusesOf(yield* h.tasks), [
      "ada:completed",
      "beto:completed",
      "ada:running",
    ]);
    assert.include(h.sent[2]!.text, "three");
  }).pipe(Effect.provide(h.layer));
});

it.effect("Stop on a usage-limited task stops its thread so the reset does not resume it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const adaThread = h.threadOf("ada");
    h.limits.set(h.runs.get(adaThread)![0]!.id, "2026-01-01T12:00:00.000Z");
    yield* h.finish(0, "failed");
    const stopped = yield* groups.taskAction({ taskId: posted.tasks[0]!.id, action: "stop" });
    assert.equal(stopped.status, "paused");
    assert.deepEqual(
      h.dispatched.filter((command) => command.type === "thread.stop").map((c) => c.threadId),
      [adaThread],
    );
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
      payload: {
        id: "r",
        threadId: h.threadOf("ada"),
        userMessageId: "plain",
        status: "completed",
      },
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
      yield* groups.member.result({
        callerThreadId: h.threadOf("ada"),
        text: "Ada's stale result",
      });
      const handed = yield* groups.member.transfer({
        callerThreadId: h.threadOf("ada"),
        member: "@beto",
        note: "numbers are in the sheet",
      });
      assert.equal(handed.status, "running");
      // A repeat is the same hand-over.
      yield* groups.member.transfer({
        callerThreadId: h.threadOf("ada"),
        member: "beto",
        note: "again",
      });
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
      assert.equal(h.sent[1]!.threadId, h.threadOf("beto"));
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
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Check the build",
    });
    assert.equal(child.status, "running");
    // A repeat of the same assignment is the same task.
    const repeat = yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
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
    assert.equal(h.sent[2]!.threadId, h.threadOf("ada"));
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

// A usage limit nothing will continue on its own (auto-resume off) fails the task as before.
it.effect.each([
  { failure: "a plain failure", limit: false },
  { failure: "a usage limit without auto-resume", limit: true },
])("a failed child still lets the parent continue, and says it failed: $failure", ({ limit }) => {
  const h = harness({ autoResume: false });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Try",
    });
    yield* h.finish(0, "completed", "waiting");
    const betoThread = h.threadOf("beto");
    const [childRun] = h.runs.get(betoThread)!;
    if (limit) {
      Object.assign(childRun!, { ordinal: 1, completedAt: DateTime.makeUnsafe(0) });
      h.limits.set(childRun!.id, "2026-01-01T12:00:00.000Z");
    }
    yield* h.finish(1, "failed");
    assert.include(h.sent[2]!.text, "- Beto (failed):");
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:running", "beto:failed"]);
    if (!limit) return;
    // Beto's next task starts, its run held behind the limited one on his thread.
    yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Again",
    });
    Object.assign(h.runs.get(betoThread)![1]!, { ordinal: 2, status: "queued" });
    // A later provider switch still continues the limited run; no task takes its answer.
    const continuation = {
      id: "run:continuation",
      threadId: betoThread,
      userMessageId: "limit-continuation:x",
      ordinal: 3,
      status: "running",
    };
    h.runs.get(betoThread)!.push(continuation);
    const update = () =>
      groups.handleRunEvent({ type: "run.updated", payload: continuation } as never);
    yield* update();
    continuation.status = "completed";
    yield* update();
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:running", "beto:failed", "beto:running"]);
    assert.lengthOf(
      (yield* h.messages).filter((row) => row.assistant_id === "beto"),
      0,
    );
    assert.lengthOf(h.sent, 4);
  }).pipe(Effect.provide(h.layer));
});

/** One turn of a member: its hand-offs or a transfer, then the answer that ends it. */
interface Turn {
  readonly handOffs?: ReadonlyArray<string>;
  readonly transferTo?: string;
  readonly text?: string;
  readonly answer: string;
}
type Member = (task: { readonly instruction: string }) => Turn;
type Harness = ReturnType<typeof harness>;

/** A run that never pauses or ends stops here, so a missing cap fails instead of hanging. */
const PLAY_TURN_LIMIT = 500;

/**
 * Plays a group as its members would: the oldest live turn makes its hand-offs and ends, until
 * nothing runs; `between` runs after each turn. Stops at the first refused hand-off, whose turn
 * the provider then interrupts. Measures, over every request, the most hand-offs in a row without
 * a delivery and since the user last acted, as the service counts them.
 */
const play = (
  h: Harness,
  members: Readonly<Record<string, Member>>,
  between: (turn: number) => Effect.Effect<unknown, AssistantError, Groups.AssistantGroups> = () =>
    Effect.void,
) =>
  Effect.gen(function* () {
    const groups = yield* Groups.AssistantGroups;
    const played = { handOffs: 0, undelivered: 0, sinceUser: 0, refused: undefined as unknown };
    // A thread runs one turn at a time: its oldest live run, as the member tools see it.
    const running = () =>
      h.tasks.pipe(
        Effect.map((rows) =>
          h.sent
            .filter((sent) =>
              h.runs
                .get(sent.threadId)
                ?.some((run) => run.userMessageId === sent.messageId && run.status === "running"),
            )
            .map((sent) =>
              rows.find(
                (row) =>
                  row.status === "running" &&
                  taskMessageId(row.task_id, row.revision) === sent.messageId,
              ),
            )
            .find((row) => row !== undefined),
        ),
      );
    for (
      let turn = 1, task = yield* running();
      task !== undefined;
      turn++, task = yield* running()
    ) {
      if (turn > PLAY_TURN_LIMIT) return { ...played, refused: "never stopped" };
      const next = members[task.owner_id]!(task);
      const callerThreadId = ThreadId.make(
        h.sent.find((row) => row.messageId === taskMessageId(task!.task_id, task!.revision))!
          .threadId,
      );
      const handOffs = [
        ...(next.handOffs ?? []).map((member) =>
          groups.member.assign({
            callerThreadId,
            member,
            instruction: next.text ?? `Work for ${member}`,
          }),
        ),
        ...(next.transferTo === undefined
          ? []
          : [groups.member.transfer({ callerThreadId, member: next.transferTo, note: "" })]),
      ];
      for (const handOff of handOffs) {
        const taken = yield* handOff.pipe(Effect.result);
        if (taken._tag === "Failure") {
          yield* h.finishTask(task.task_id, "interrupted");
          return { ...played, refused: taken.failure.message };
        }
        played.handOffs += 1;
        const root = (yield* h.tasks).find((row) => row.task_id === task!.root_id)!;
        played.undelivered = Math.max(played.undelivered, root.undelivered_hops);
        played.sinceUser = Math.max(played.sinceUser, root.hops);
      }
      yield* h.finishTask(task.task_id, "completed", next.answer);
      yield* between(turn);
    }
    return played;
  });

/**
 * Makers send their work to the reviewer; the reviewer finds a problem in the flawed ones on the
 * first review and on every one before the last, and each fix goes back for review until
 * `reviewRounds` reviews were done. A maker's work is named by its instruction.
 */
const reviewLoop = (
  reviewer: string,
  flawed: (work: string) => boolean,
  reviewRounds: number,
): { readonly maker: Member; readonly reviewer: Member } => {
  const reviews = new Map<string, number>();
  const verdicts = new Map<string, "fix" | "pass">();
  return {
    maker: (task) => {
      const work = /^(?:Work for|Fix) (.+)$/.exec(task.instruction)?.[1] ?? task.instruction;
      const done = reviews.get(work) ?? 0;
      if (done === 0 || (verdicts.get(work) === "fix" && done < reviewRounds)) {
        reviews.set(work, done + 1);
        return { handOffs: [reviewer], text: `Review ${work}, round ${done + 1}`, answer: "Sent" };
      }
      return { answer: `${work} is done` };
    },
    reviewer: (task) => {
      const [, work = "", round = "0"] = /^Review (.+), round (\d+)$/.exec(task.instruction) ?? [];
      const fix = flawed(work) && (round === "1" || Number(round) < reviewRounds);
      verdicts.set(work, fix ? "fix" : "pass");
      return { answer: fix ? `${work} needs a fix (round ${round})` : `${work} passes` };
    },
  };
};

interface Team {
  readonly lead: string;
  readonly brief: string;
  readonly makers: ReadonlyArray<string>;
  readonly reviewer: string;
  readonly flawed: ReadonlyArray<string>;
}
const DEV_TEAM: Team = {
  lead: "techlead",
  brief: "analyst",
  makers: ["front", "back", "mobile"],
  reviewer: "qa",
  flawed: ["back", "front"],
};
/** The widest split a group of eight makes: five makers start before any review comes back. */
const WIDE_DEV_TEAM: Team = { ...DEV_TEAM, makers: ["front", "back", "mobile", "web", "data"] };
const CONTENT_TEAM: Team = {
  lead: "editor",
  brief: "researcher",
  makers: ["writer", "designer"],
  reviewer: "reviewer",
  flawed: ["writer", "designer"],
};
const membersOf = (team: Team) => [team.lead, team.brief, ...team.makers, team.reviewer];

/** One request: the lead gets a brief, splits the work across the makers, then delivers. */
const teamFlow = (team: Team, reviewRounds: number): Record<string, Member> => {
  const loop = reviewLoop(team.reviewer, (work) => team.flawed.includes(work), reviewRounds);
  let leadTurns = 0;
  return {
    [team.lead]: () => {
      leadTurns += 1;
      if (leadTurns === 1)
        return { handOffs: [team.brief], text: "Write the brief", answer: "Asked" };
      if (leadTurns > 2) return { answer: "Delivered" };
      return { handOffs: team.makers, answer: "Split" };
    },
    [team.brief]: () => ({ answer: "Brief ready" }),
    ...Object.fromEntries(team.makers.map((name) => [name, loop.maker])),
    [team.reviewer]: loop.reviewer,
  };
};

const BUG_OWNERS = ["back", "front", "mobile", "back", "front"];

/**
 * One message that lists five bugs: the lead takes them one at a time, each analysed, fixed by its
 * maker and reviewed, every review finding a problem until the last round.
 */
const bugListFlow = (reviewRounds: number): Record<string, Member> => {
  const loop = reviewLoop("qa", () => true, reviewRounds);
  let leadTurns = 0;
  return {
    techlead: () => {
      leadTurns += 1;
      const bug = Math.ceil(leadTurns / 2);
      if (bug > BUG_OWNERS.length) return { answer: "All five fixed" };
      return leadTurns % 2 === 1
        ? { handOffs: ["analyst"], text: `Analyse bug ${bug}`, answer: "Asked" }
        : { handOffs: [BUG_OWNERS[bug - 1]!], text: `Fix bug ${bug}`, answer: "Assigned" };
    },
    analyst: (task) => ({ answer: `Cause found: ${task.instruction}` }),
    front: loop.maker,
    back: loop.maker,
    mobile: loop.maker,
    qa: loop.reviewer,
  };
};

/** The user reports five bugs to Back, one message every other turn, while the request runs. */
const fiveBugMessages = (turn: number) =>
  Groups.AssistantGroups.pipe(
    Effect.flatMap((groups) =>
      turn % 2 === 0 && turn <= 10
        ? groups.post(
            { teamId: TEAM, text: `@back bug ${turn / 2}: the form loses its input` },
            { kind: "user" },
          )
        : Effect.void,
    ),
  );

// Measured with both caps out of the way: the caps in contracts are sized from these numbers.
it.effect.each([
  { name: "dev, 1 review round", team: DEV_TEAM, flow: "team", rounds: 1, measured: [7, 6, 7] },
  { name: "dev, 2 review rounds", team: DEV_TEAM, flow: "team", rounds: 2, measured: [9, 6, 9] },
  { name: "dev, 3 review rounds", team: DEV_TEAM, flow: "team", rounds: 3, measured: [11, 6, 11] },
  {
    name: "dev with 5 makers, 3 rounds",
    team: WIDE_DEV_TEAM,
    flow: "team",
    rounds: 3,
    measured: [15, 10, 15],
  },
  {
    name: "dev, 3 rounds, 5 bug messages",
    team: DEV_TEAM,
    flow: "bugs",
    rounds: 3,
    // Each bug message is a request of its own, so it no longer resets the first one's counts.
    measured: [16, 6, 11],
  },
  {
    name: "content, 1 review round",
    team: CONTENT_TEAM,
    flow: "team",
    rounds: 1,
    measured: [5, 4, 5],
  },
  {
    name: "content, 2 review rounds",
    team: CONTENT_TEAM,
    flow: "team",
    rounds: 2,
    measured: [7, 4, 7],
  },
  {
    name: "content, 3 review rounds",
    team: CONTENT_TEAM,
    flow: "team",
    rounds: 3,
    measured: [9, 4, 9],
  },
  {
    name: "list of 5 bugs, 1 round",
    team: DEV_TEAM,
    flow: "list",
    rounds: 1,
    measured: [15, 2, 15],
  },
  {
    name: "list of 5 bugs, 2 rounds",
    team: DEV_TEAM,
    flow: "list",
    rounds: 2,
    measured: [20, 2, 20],
  },
  {
    name: "list of 5 bugs, 3 rounds",
    team: DEV_TEAM,
    flow: "list",
    rounds: 3,
    measured: [25, 2, 25],
  },
] as const)(
  "a real team's request runs to the end without a pause: $name",
  ({ team, flow, rounds, measured }) => {
    const members = membersOf(team);
    const h = harness({ assistants: members, members, lead: team.lead });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const request = flow === "list" ? "fix these five bugs" : "ship it";
      yield* groups.post({ teamId: TEAM, text: `@${team.lead} ${request}` }, h.user);
      const played = yield* play(
        h,
        flow === "list" ? bugListFlow(rounds) : teamFlow(team, rounds),
        flow === "bugs" ? fiveBugMessages : undefined,
      );
      // [hand-offs, longest stretch without a delivery, most since the user last acted]
      assert.deepEqual(
        [played.handOffs, played.undelivered, played.sinceUser, played.refused],
        [...measured, undefined],
      );
      assert.isAtMost(played.undelivered, ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY);
      assert.isAtMost(played.sinceUser, ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION);
      assert.equal((yield* h.tasks)[0]!.status, "completed");
    }).pipe(Effect.provide(h.layer));
  },
);

/** Members that pass work around for ever: by assignment, by transfer, or in a triangle. */
const endlessLoop = (shape: "assign" | "transfer" | "triangle"): Record<string, Member> => {
  const next = (to: string): Member =>
    shape === "transfer"
      ? () => ({ transferTo: to, answer: "Yours" })
      : () => ({ handOffs: [to], answer: "Yours" });
  return shape === "triangle"
    ? { ada: next("beto"), beto: next("cy"), cy: next("ada") }
    : { ada: next("beto"), beto: next("ada") };
};

/** Ada keeps sending Beto a review and Beto keeps answering: a new answer, the same one, or none. */
const reviewForEver = (answer: "new" | "same" | "empty"): Record<string, Member> => {
  let round = 0;
  return {
    ada: () => {
      round += 1;
      return { handOffs: ["beto"], text: `Review round ${round}`, answer: "Fixed" };
    },
    beto: (task) => ({
      answer:
        answer === "new"
          ? `Found a bug in ${task.instruction}`
          : answer === "same"
            ? "Found a bug"
            : "",
    }),
  };
};

const W = ASSISTANT_GROUP_HANDOFFS_WITHOUT_DELIVERY;
const C = ASSISTANT_GROUP_HANDOFFS_PER_USER_ACTION;

it.effect.each([
  {
    name: "ping-pong by assignment",
    members: endlessLoop("assign"),
    handOffs: W,
    cap: "no_delivery",
  },
  {
    name: "ping-pong by transfer",
    members: endlessLoop("transfer"),
    handOffs: W,
    cap: "no_delivery",
  },
  {
    name: "triangle with no delivery",
    members: endlessLoop("triangle"),
    handOffs: W,
    cap: "no_delivery",
  },
  {
    name: "loop repeating one answer",
    members: reviewForEver("same"),
    handOffs: W + 1,
    cap: "no_delivery",
  },
  {
    name: "loop with empty answers",
    members: reviewForEver("empty"),
    handOffs: W,
    cap: "no_delivery",
  },
  {
    name: "loop that keeps delivering",
    members: reviewForEver("new"),
    handOffs: C,
    cap: "handoff_limit",
  },
] as const)(
  "a loop with nobody watching stops the whole request: $name",
  ({ members, handOffs, cap }) => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada settle it" }, h.user);
      const played = yield* play(h, members);
      assert.deepEqual([played.handOffs, played.refused], [handOffs, HANDOFF_PAUSES[cap].refusal]);
      // Everything in flight pauses, the refused turn is interrupted, and the chat says which cap.
      const tasks = yield* h.tasks;
      assert.deepEqual(
        [
          ...new Set(
            tasks
              .filter((task) => task.status !== "completed")
              .map((task) => `${task.status}:${task.reason}`),
          ),
        ],
        [`paused:${cap}`],
      );
      assert.deepEqual(
        [(yield* h.messages).at(-1)!.kind, (yield* h.messages).at(-1)!.text],
        ["notice", HANDOFF_PAUSES[cap].notice],
      );
      assert.isNotEmpty(h.dispatched.filter((command) => command.type === "run.interrupt"));
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "only a task that finishes with an answer delivers; a question or a failure does not",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada plan the launch" }, h.user);
      const undelivered = h.tasks.pipe(Effect.map((rows) => rows[0]!.undelivered_hops));
      const build = yield* groups.member.assign({
        callerThreadId: h.threadOf("ada"),
        member: "beto",
        instruction: "Check the build",
      });
      const design = yield* groups.member.assign({
        callerThreadId: h.threadOf("ada"),
        member: "cy",
        instruction: "Draw the logo",
      });
      assert.equal(yield* undelivered, 2);
      yield* h.finishTask(build.taskId, "completed", "Build is green.");
      assert.equal(yield* undelivered, 0);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE assistant_group_tasks SET undelivered_hops = 5 WHERE parent_id IS NULL`;
      yield* h.finishTask(design.taskId, "failed");
      const answer = (yield* h.messages).find((row) => row.assistant_id === "beto")!;
      yield* groups.member.reply({
        callerThreadId: h.threadOf("ada"),
        messageId: answer.message_id,
        text: "Which branch?",
      });
      const question = (yield* h.tasks).find((row) => row.kind === "reply")!;
      yield* h.finishTask(question.task_id, "completed", "Main.");
      assert.equal(yield* undelivered, 5);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("every way the user lets a stopped request go on clears both counts", () => {
  const h = harness({ members: ["ada", "beto"] });
  const loop = endlessLoop("assign");
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada settle it with Beto" }, h.user);
    yield* play(h, loop);
    // Any card of the stopped request picks it up from its root, not only the root's own card.
    const root = (yield* h.tasks)[0]!.task_id as never;
    for (const goAhead of [
      groups.taskAction({ taskId: root, action: "resume" }),
      h.tasks.pipe(
        Effect.flatMap((rows) =>
          groups.taskAction({ taskId: rows.at(-1)!.task_id as never, action: "resume" }),
        ),
      ),
      groups.taskAction({ taskId: root, action: "reassign", ownerId: AssistantId.make("ada") }),
      groups.post({ teamId: TEAM, text: "continue" }, h.user),
    ]) {
      const [before] = yield* h.tasks;
      assert.deepEqual([before!.hops, before!.undelivered_hops], [W, W]);
      yield* goAhead;
      const [after] = yield* h.tasks;
      assert.deepEqual([after!.status, after!.hops, after!.undelivered_hops], ["waiting", 0, 0]);
      assert.deepEqual((yield* play(h, loop)).refused, HANDOFF_PAUSES.no_delivery.refusal);
    }
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { name: "the user", author: { kind: "user" } as const, stops: false },
  {
    name: "an agent",
    author: { kind: "agent", assistantId: null, label: "Planning chat" } as const,
    stops: true,
  },
  { name: "a routine", author: { kind: "routine", label: "Monday report" } as const, stops: true },
])("a loop between two members goes on only while $name writes to them", ({ author, stops }) => {
  const h = harness({ members: ["ada", "beto"] });
  let handOffs = 0;
  const turn =
    (other: string): Member =>
    (task) => {
      if (task.instruction.includes("question") || handOffs >= 2 * W) return { answer: "Done" };
      handOffs += 1;
      return { handOffs: [other], answer: "Your turn" };
    };
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const request = yield* groups.post({ teamId: TEAM, text: "@ada settle it with Beto" }, h.user);
    const played = yield* play(h, { ada: turn("beto"), beto: turn("ada") }, (at) =>
      at % 3 === 0
        ? groups.post(
            {
              teamId: TEAM,
              text: `@beto a question ${at}`,
              replyToMessageId: request.message.id,
            },
            author,
          )
        : Effect.void,
    );
    assert.deepEqual(
      [played.handOffs, played.refused],
      stops ? [W, HANDOFF_PAUSES.no_delivery.refusal] : [2 * W, undefined],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { name: "a reply to a member's answer", author: "user", via: "answer", restarts: true },
  { name: "a user reply the lead routes", author: "user", via: "request", restarts: true },
  { name: "a new user message", author: "user", via: "new", restarts: false },
  { name: "an agent reply the lead routes", author: "agent", via: "request", restarts: false },
  { name: "a routine reply the lead routes", author: "routine", via: "request", restarts: false },
] as const)(
  "a message in a live request clears both counts only from the user: $name",
  ({ author, via, restarts }) => {
    const h = harness({ lead: "cy", routable: [codex], route: () => ["beto"] });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const request = yield* groups.post(
        { teamId: TEAM, text: "@ada @cy plan the launch" },
        h.user,
      );
      yield* h.finish(1, "completed", "Cy is done.");
      const child = yield* groups.member.assign({
        callerThreadId: h.threadOf("ada"),
        member: "beto",
        instruction: "Check the build",
      });
      yield* h.finishTask(child.taskId, "completed", "Build is green.");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE assistant_group_tasks SET hops = 5, undelivered_hops = 4 WHERE parent_id IS NULL`;
      const betoAnswer = (yield* h.messages).find((row) => row.assistant_id === "beto")!;
      // A new message is another request; a reply to the request itself has two members working
      // it, so the lead routes it.
      const replyTo =
        via === "answer"
          ? betoAnswer.message_id
          : via === "request"
            ? request.message.id
            : undefined;
      yield* groups.post(
        {
          teamId: TEAM,
          text: "the build is red again",
          ...(replyTo === undefined ? {} : { replyToMessageId: replyTo as never }),
        },
        author === "user"
          ? h.user
          : author === "agent"
            ? { kind: "agent", assistantId: null, label: "Planning chat" }
            : { kind: "routine", label: "Monday report" },
      );
      yield* groups.idle;
      assert.lengthOf(h.routeCalls, via === "answer" ? 0 : 1);
      const [root] = yield* h.tasks;
      assert.deepEqual([root!.hops, root!.undelivered_hops], restarts ? [0, 0] : [5, 4]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each(["no_delivery", "handoff_limit"] as const)(
  "a transfer past a cap is refused too and stops the request: %s",
  (cap) => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
      const sql = yield* SqlClient.SqlClient;
      yield* cap === "no_delivery"
        ? sql`UPDATE assistant_group_tasks SET undelivered_hops = ${W}`
        : sql`UPDATE assistant_group_tasks SET hops = ${C}`;
      const refused = yield* refusalError(
        groups.member.transfer({ callerThreadId: h.threadOf("ada"), member: "cy", note: "" }),
      );
      assert.equal(refused.message, HANDOFF_PAUSES[cap].refusal);
      assert.deepEqual(
        (yield* h.tasks).map((task) => [task.owner_id, task.status, task.reason]),
        [["ada", "paused", cap]],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

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
    const ada = h.threadOf("ada");
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
      yield* refusal(call.result({ callerThreadId: h.threadOf("beto"), text: "x" })),
      "invalid: This tool only works inside a group task.",
    );
    // Beto has no task yet, even though its thread exists.
    yield* groups.post({ teamId: TEAM, text: "@cy hi" }, h.user);
    yield* h.finish(1, "completed", "done");
    assert.equal(
      yield* refusal(call.result({ callerThreadId: h.threadOf("cy"), text: "x" })),
      "invalid: No task of yours is running in this group.",
    );
    const long = "q".repeat(ASSISTANT_GROUP_REPLY_MAX_CHARS + 1);
    assert.include(
      yield* refusal(call.reply({ callerThreadId: ada, messageId: "gm:none", text: long })),
      `under ${ASSISTANT_GROUP_REPLY_MAX_CHARS} characters`,
    );
    const answer = (yield* h.messages).find((row) => row.author === "assistant")!;
    // Cy's answer belongs to another request: Ada cannot ask about it from hers.
    for (const [messageId, expected] of [
      ["gm:none", "Reply to a message a member wrote in this request."],
      [(yield* h.messages)[0]!.message_id, "Reply to a message a member wrote in this request."],
      [answer.message_id, "Reply to a message a member wrote in this request."],
    ] as const) {
      assert.equal(
        yield* refusal(call.reply({ callerThreadId: ada, messageId, text: "q?" })),
        `invalid: ${expected}`,
      );
    }
    assert.equal(
      yield* refusal(
        call.reply({ callerThreadId: h.threadOf("cy"), messageId: answer.message_id, text: "q?" }),
      ),
      "invalid: No task of yours is running in this group.",
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("questions between members: two per request, a reply task only answers", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    // Beto and Cy each have an answer in the request to ask about.
    const request = yield* groups.post({ teamId: TEAM, text: "@beto @cy prepare" }, h.user);
    yield* h.finish(0, "completed", "Beto's draft");
    yield* h.finish(1, "completed", "Cy's draft");
    const [, betoAnswer, cyAnswer] = yield* h.messages;
    yield* groups.post(
      { teamId: TEAM, text: "@ada review them", replyToMessageId: request.message.id },
      h.user,
    );

    const first = yield* groups.member.reply({
      callerThreadId: h.threadOf("ada"),
      messageId: betoAnswer!.message_id,
      text: "Which build?",
    });
    assert.isTrue(first.accepted);
    // A repeat of the same question is the same reply.
    const repeat = yield* groups.member.reply({
      callerThreadId: h.threadOf("ada"),
      messageId: betoAnswer!.message_id,
      text: "Which build?",
    });
    assert.deepEqual(repeat, first);
    assert.lengthOf(
      (yield* h.tasks).filter((task) => task.kind === "reply"),
      1,
    );

    const question = h.sent.at(-1)!;
    assert.equal(question.threadId, h.threadOf("beto"));
    assert.include(question.text, 'kind="reply"');
    assert.include(
      question.text,
      "Your task: Question from Ada (a teammate, not the user): Which build?",
    );
    assert.include(question.text, "only answers the question");

    // Ada cannot post her result while the question is open.
    const blocked = yield* groups.member.result({
      callerThreadId: h.threadOf("ada"),
      text: "Done",
    });
    assert.isFalse(blocked.accepted);

    // The asked member may only answer: nothing else works from a reply task.
    for (const attempt of [
      groups.member.assign({ callerThreadId: h.threadOf("beto"), member: "cy", instruction: "x" }),
      groups.member.transfer({ callerThreadId: h.threadOf("beto"), member: "cy", note: "" }),
      groups.member.reply({
        callerThreadId: h.threadOf("beto"),
        messageId: cyAnswer!.message_id,
        text: "?",
      }),
    ]) {
      const error = yield* refusalError(attempt);
      assert.equal(error.message, "This task only answers a question. Use t3_group result.");
    }

    // The member message by its number in the chat, as the packet shows it.
    const second = yield* groups.member.reply({
      callerThreadId: h.threadOf("ada"),
      seq: cyAnswer!.seq,
      text: "Which font?",
    });
    assert.isTrue(second.accepted);
    // The third question of the same request is refused, whoever writes it.
    const third = yield* groups.member.reply({
      callerThreadId: h.threadOf("ada"),
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
    const ok = yield* groups.member.result({
      callerThreadId: h.threadOf("ada"),
      text: "Review done",
    });
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
    yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Part",
    });
    yield* groups.post({ teamId: TEAM, text: "@cy other" }, h.user);
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:running", "beto:running", "cy:queued"]);
    const [root] = yield* h.tasks;
    yield* groups.taskAction({ taskId: root!.task_id as never, action: "stop" });
    assert.deepEqual(statusesOf(yield* h.tasks), ["ada:paused", "beto:paused", "cy:running"]);
    assert.deepEqual(
      h.dispatched.filter((command) => command.type === "run.interrupt").map((c) => c.threadId),
      [h.threadOf("ada"), h.threadOf("beto")],
    );
    // The interruption that follows changes nothing: the tasks were already paused.
    yield* h.finish(0, "interrupted");
    assert.equal((yield* h.tasks)[0]!.status, "paused");
    assert.equal((yield* h.tasks)[0]!.reason, "stopped");
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { way: "resume", childFailed: false },
  { way: "reassign", childFailed: false },
  { way: "continue", childFailed: false },
  { way: "reassign", childFailed: true },
] as const)(
  "a stopped request picks up with what it assigned, so the parent is not left waiting: $way",
  ({ way, childFailed }) => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const request = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
      yield* groups.member.assign({
        callerThreadId: h.threadOf("ada"),
        member: "beto",
        instruction: "Part",
      });
      const [root, child] = yield* h.tasks;
      if (childFailed) yield* h.finishTask(child!.task_id, "failed");
      yield* groups.taskAction({ taskId: root!.task_id as never, action: "stop" });
      if (way === "continue") yield* groups.post({ teamId: TEAM, text: "continue" }, h.user);
      else if (way === "resume")
        yield* groups.taskAction({ taskId: root!.task_id as never, action: "resume" });
      else
        yield* groups.taskAction({
          taskId: root!.task_id as never,
          action: "reassign",
          ownerId: AssistantId.make("cy"),
        });
      const owner = way === "reassign" ? "cy" : "ada";
      assert.deepEqual(statusesOf(yield* h.tasks), [`${owner}:waiting`, "beto:running"]);
      yield* h.finishTask(child!.task_id, "completed", "Part done.");
      assert.deepEqual(statusesOf(yield* h.tasks), [`${owner}:running`, "beto:completed"]);
      // The parent goes on in the request's thread of whoever owns it now.
      assert.equal(h.sent.at(-1)!.threadId, requestThreadId(owner, TEAM, request.message.id));
      assert.include(h.sent.at(-1)!.text, "- Beto (completed): Part done.");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each([
  { root: "paused", starts: false },
  { root: "failed", starts: false },
  { root: "cancelled", starts: false },
  { root: "waiting", starts: true },
] as const)("queued work starts only while its request is live: root $root", ({ root, starts }) => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Part",
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE assistant_group_tasks SET status = ${root} WHERE parent_id IS NULL`;
    yield* sql`UPDATE assistant_group_tasks SET status = 'queued' WHERE parent_id IS NOT NULL`;
    const before = h.sent.length;
    // Any new message runs the scheduler.
    yield* groups.post({ teamId: TEAM, text: "@cy other" }, h.user);
    assert.deepEqual(statusesOf(yield* h.tasks), [
      `ada:${root}`,
      `beto:${starts ? "running" : "queued"}`,
      "cy:running",
    ]);
    assert.deepEqual(
      h.sent.slice(before).map((row) => row.threadId),
      starts ? [h.threadOf("beto"), h.threadOf("cy")] : [h.threadOf("cy")],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a queued run that has not started is cancelled instead of interrupted", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    h.runs.get(h.threadOf("ada"))![0]!.status = "queued";
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
          ["run.interrupt", h.threadOf("ada")],
          ["thread.archive", h.threadOf("ada")],
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
          [h.threadOf("ada"), "Ada · Board · one"],
          [h.threadOf("beto"), "Beto · Board · two"],
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
    const go = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    yield* groups.post({ teamId: OTHER_TEAM, text: "@ada elsewhere" }, h.user);
    yield* groups.handleAssistantEvent({ type: "teamRemoved", teamId: TEAM });
    assert.deepEqual(h.deletedTeams, [TEAM]);
    const thread = go.tasks[0]!.threadId;
    assert.deepEqual(
      h.dispatched.map((command) => [command.type, command.threadId]),
      [
        ["run.interrupt", thread],
        ["thread.delete", thread],
      ],
    );
    const left = yield* h.sqlRows<{ team_id: string }>(
      "SELECT team_id FROM assistant_group_tasks UNION ALL SELECT team_id FROM assistant_group_messages UNION ALL SELECT team_id FROM assistant_group_request_threads",
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
      assert.equal(h.sent[0]!.threadId, h.threadOf("cy"));
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
      (yield* refuse({ callerThreadId: h.threadOf("ada"), group: TEAM, text: "x" })).message,
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

it.effect("a member reads its request's older messages in pages, a very long one cut", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    const go = yield* groups.post({ teamId: TEAM, text: "@ada go" }, h.user);
    const long = "z".repeat(17_000);
    for (let n = 2; n <= 5; n++) {
      yield* sql`INSERT INTO assistant_group_messages
        (message_id, team_id, seq, author, kind, text, request_id, created_at)
        VALUES (${`gm:${n}`}, ${TEAM}, ${n}, 'user', 'message', ${long}, ${go.message.id}, '2026-01-01')`;
    }
    // Another request's message never shows up in Ada's history.
    yield* sql`INSERT INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, request_id, created_at)
      VALUES ('gm:other', ${TEAM}, 6, 'user', 'message', 'not hers', 'gm:other', '2026-01-01')`;
    const page = yield* groups.member.history({ callerThreadId: h.threadOf("ada") });
    // 24k characters: one cut message (16k) fits, the next does not.
    assert.deepEqual(
      page.messages.map((message) => message.seq),
      [5],
    );
    assert.isTrue(page.hasMore);
    assert.isAtMost(page.messages[0]!.text.length, 16_001);
    const earlier = yield* groups.member.history({
      callerThreadId: h.threadOf("ada"),
      beforeSeq: 5,
    });
    assert.deepEqual(
      earlier.messages.map((message) => message.seq),
      [4],
    );
    const small = yield* groups.member.history({ callerThreadId: h.threadOf("ada"), beforeSeq: 2 });
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
            callerThreadId: h.threadOf("ada"),
            messageId: (yield* h.messages).find((row) => row.assistant_id === null)!.message_id,
            text: "?",
          }),
        ),
        "Reply to a message a member wrote in this request.",
      );
      yield* sql`UPDATE assistant_teams SET member_ids_json = '["ada","cy"]' WHERE team_id = ${TEAM}`;
      assert.equal(
        yield* failure(
          groups.member.reply({
            callerThreadId: h.threadOf("ada"),
            messageId: betoAnswer.message_id,
            text: "?",
          }),
        ),
        "That member is no longer in the group.",
      );
      yield* sql`UPDATE assistant_teams SET archived_at = 'now' WHERE team_id = ${TEAM}`;
      assert.equal(
        yield* failure(groups.member.result({ callerThreadId: h.threadOf("ada"), text: "done" })),
        "This group is archived.",
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("a member cannot ask itself", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const first = yield* groups.post({ teamId: TEAM, text: "@ada first" }, h.user);
    yield* h.finish(0, "completed", "Ada's answer");
    const own = (yield* h.messages).find((row) => row.assistant_id === "ada")!;
    yield* groups.post(
      { teamId: TEAM, text: "@ada again", replyToMessageId: first.message.id },
      h.user,
    );
    const error = yield* groups.member
      .reply({ callerThreadId: h.threadOf("ada"), messageId: own.message_id, text: "me?" })
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
      yield* groups.member.transfer({
        callerThreadId: h.threadOf("ada"),
        member: "beto",
        note: "yours",
      });
      yield* h.finish(0, "completed", "handed off");
      const betoTurn = h.sent.find((message) => message.threadId === h.threadOf("beto"))!;
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

it.effect("compact gives the lead a summary; a new conversation drops it and the old chat", () => {
  const h = harness({
    lead: "beto",
    routable: [claude],
    route: () => ["ada"],
    summarize: () => "Compact summary.",
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const route = () =>
      h.routeCalls.at(-1) as { summary: string | null; recentMessages: Array<{ text: string }> };
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    yield* h.finish(0, "completed", "done one");
    yield* groups.conversation({ teamId: TEAM, action: "compact" });
    assert.lengthOf(h.summaryCalls, 1);
    // Nothing new since: nothing to compact.
    const none = yield* groups.conversation({ teamId: TEAM, action: "compact" }).pipe(Effect.flip);
    assert.equal(none.reason, "invalid");
    // Only the lead reads the summary; a member's packet carries its own request alone.
    yield* groups.post({ teamId: TEAM, text: "who can help" }, h.user);
    assert.equal(route().summary, "Compact summary.");
    assert.notInclude(
      route()
        .recentMessages.map((m) => m.text)
        .join("\n"),
      "done one",
    );
    assert.notInclude(h.sent.at(-1)!.text, "Compact summary.");
    assert.notInclude(h.sent.at(-1)!.text, "done one");
    yield* h.finish(1, "completed", "ok");
    yield* groups.conversation({ teamId: TEAM, action: "new" });
    assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
    assert.deepEqual(
      (yield* h.messages).filter((row) => row.kind === "boundary").map((row) => row.text),
      ["compact", "new"],
    );
    yield* groups.post({ teamId: TEAM, text: "anyone free" }, h.user);
    assert.isNull(route().summary);
    assert.deepEqual(
      route().recentMessages.map((m) => m.text),
      [],
    );
    // The old messages stay in the chat.
    assert.isAbove((yield* groups.history({ teamId: TEAM })).messages.length, 4);
  }).pipe(Effect.provide(h.layer));
});

it.effect("a summary still running when a new conversation starts is dropped", () => {
  const gate = Deferred.makeUnsafe<void>();
  const started = Deferred.makeUnsafe<void>();
  const h = harness({
    summarize: (call) => {
      if (call > 0) Deferred.doneUnsafe(started, Effect.void);
      return "Stale summary.";
    },
    summaryGate: gate,
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
    yield* h.finish(0, "completed", "ok");
    const compact = yield* groups
      .conversation({ teamId: TEAM, action: "compact" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* groups.conversation({ teamId: TEAM, action: "new" });
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(compact);
    assert.lengthOf(h.summaryCalls, 1);
    assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_summaries"), 0);
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

it.effect(
  "clear deletes the chat, its tasks, summary and files; members keep their conversations",
  () => {
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
      // The requests' conversations stay, settled and unlinked; the next request gets a fresh one.
      const first = posted.tasks[0]!.threadId;
      assert.notDeepInclude(
        h.dispatched.map((command) => [command.type, command.threadId]),
        ["thread.delete", first],
      );
      assert.deepInclude(h.fakeThreads.get(first)!, {
        deletedAt: null,
        settledOverride: "settled",
      });
      assert.lengthOf(yield* h.sqlRows("SELECT * FROM assistant_group_request_threads"), 0);
      yield* groups.post({ teamId: TEAM, text: "@ada again" }, h.user);
      assert.include(h.sent.at(-1)!.text, "again");
      assert.notEqual(h.sent.at(-1)!.threadId, first);
      assert.deepEqual(
        (yield* h.messages).map((row) => row.seq),
        [1],
      );
      // The kept conversation is still the member's: it goes when the member is deleted.
      yield* groups.handleAssistantEvent({ type: "removed", assistantId: "ada" as never });
      assert.deepInclude(
        h.dispatched.map((command) => [command.type, command.threadId]),
        ["thread.delete", first],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

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
    const earlier = yield* groups.post({ teamId: TEAM, text: "@beto earlier thing" }, h.user);
    yield* h.finish(0, "completed", "ok");
    yield* groups.post({ teamId: TEAM, text: "@cy unrelated" }, h.user);
    yield* h.finish(1, "completed", "cy ok");
    yield* groups.post(
      { teamId: TEAM, text: "@ada go", replyToMessageId: earlier.message.id },
      h.user,
    );
    const child = yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Build it",
      expectedResult: "  the build is green  ",
      sourceSeqs: [1, 1, -3, 99, 3],
      resources: ["Folder: /w/app/", "Browser", "browser", " "],
    });
    const [row] = yield* h.sqlRows<{
      expected_result: string;
      source_seqs_json: string;
      resources_json: string;
    }>(`SELECT * FROM assistant_group_tasks WHERE task_id = '${child.taskId}'`);
    assert.deepEqual(
      [row!.expected_result, row!.source_seqs_json, row!.resources_json],
      ["the build is green", "[1,99,3]", '["folder:/w/app","browser"]'],
    );
    const packet = h.sent.at(-1)!.text;
    assert.include(packet, "Earlier messages this task refers to:\n[#1 user] @beto earlier thing");
    // Another request's message is never quoted, even by number.
    assert.notInclude(packet, "unrelated");
    assert.include(packet, "Expected result: the build is green");
    assert.include(packet, "folder:/w/app, browser");
    // A repeat lands on the same task.
    const repeat = yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
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
    yield* assignWith(groups, h.threadOf("ada"), "beto", "A", ["folder:/w/app"]);
    yield* assignWith(groups, h.threadOf("ada"), "cy", "B", ["folder:/w/app/src"]);
    yield* assignWith(groups, h.threadOf("ada"), "beto", "C", ["folder:/w/app"]);
    yield* assignWith(groups, h.threadOf("ada"), "cy", "D", ["folder:/w/other"]);
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
      yield* assignWith(groups, h.threadOf("ada"), "beto", "Part", ["browser"]);
      const grandchild = yield* assignWith(groups, h.threadOf("beto"), "cy", "Sub", ["browser"]);
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
    const held = yield* assignWith(groups, h.threadOf("ada"), "beto", "A", ["browser"]);
    const waiter = yield* assignWith(groups, h.threadOf("ada"), "cy", "B", ["browser"]);
    const [root] = yield* h.tasks;
    for (const taskId of [held.taskId, root!.task_id, "gt:none"]) {
      const refused = yield* refusalError(
        groups.member.cancel({ callerThreadId: h.threadOf("beto"), taskId, reason: "no" }),
      );
      assert.equal(refused.message, "You can only cancel a task you assigned.");
    }
    const asked = yield* groups.member.cancel({
      callerThreadId: h.threadOf("ada"),
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
    assert.deepEqual(interrupts(), [h.threadOf("beto")]);
    const again = yield* groups.member.cancel({
      callerThreadId: h.threadOf("ada"),
      taskId: held.taskId,
      reason: "again",
    });
    assert.deepEqual(again, { accepted: true, message: "Already cancelled." });
    assert.deepEqual(interrupts(), [h.threadOf("beto")]);
    assert.equal(waiter.status, "queued");
    // The interruption that follows changes nothing: the task was already cancelled.
    yield* h.finish(1, "interrupted");
    assert.equal((yield* h.tasks)[1]!.status, "cancelled");
    // A completed task cannot be cancelled.
    yield* h.finish(2, "completed", "B done");
    const late = yield* groups.member.cancel({
      callerThreadId: h.threadOf("ada"),
      taskId: waiter.taskId,
      reason: "",
    });
    assert.deepEqual(late, { accepted: false, message: "That task is already completed." });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a packet lists the member's stopped and failed tasks in its request, newest first and capped",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, request_id, created_at)
      VALUES ('gm:old', ${TEAM}, 1, 'user', 'message', 'old', 'gm:old', '2026-01-01'),
        ('gm:else', ${TEAM}, 2, 'user', 'message', 'else', 'gm:else', '2026-01-01')`;
      for (let index = 0; index < 7; index += 1) {
        yield* sql`INSERT INTO assistant_group_tasks
        (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status, reason,
         request_id, revision, hops, created_at, updated_at)
        VALUES (${`gt:s${index}`}, ${TEAM}, ${`gt:s${index}`}, 'root', 'gm:old', 'ada',
          ${`stopped job ${index} ${"x".repeat(200)}`}, ${index === 6 ? "failed" : "paused"},
          ${index === 6 ? "failed" : "stopped"}, 'gm:old', 1, 0, '2026-01-01', ${`2026-01-0${index + 1}`})`;
      }
      yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
       request_id, revision, hops, created_at, updated_at)
      VALUES ('gt:other', ${TEAM}, 'gt:other', 'root', 'gm:old', 'beto', 'not hers', 'paused', 'gm:old', 1, 0,
        '2026-01-01', '2026-01-09')`;
      yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, parent_id, kind, request_message_id, owner_id, instruction, status,
       request_id, revision, hops, created_at, updated_at)
      VALUES ('gt:kid', ${TEAM}, 'gt:s0', 'gt:s0', 'child', 'gm:old', 'beto', 'price the plan',
        'running', 'gm:old', 1, 0, '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status,
       request_id, revision, hops, created_at, updated_at)
      VALUES ('gt:else', ${TEAM}, 'gt:else', 'root', 'gm:else', 'ada', 'another request', 'paused',
        'gm:else', 1, 0, '2026-01-01', '2026-01-09')`;
      yield* groups.post(
        { teamId: TEAM, text: "@ada next", replyToMessageId: "gm:old" as AssistantGroupMessageId },
        h.user,
      );
      const packet = h.sent[0]!.text;
      assert.include(
        packet,
        "Subtasks you gave that are still open (t3_group cancel stops one):\n- gt:kid (running, Beto): price the plan",
      );
      const listed = packet.split("\n").filter((line) => line.startsWith("- gt:s"));
      assert.lengthOf(listed, 5);
      assert.include(packet, "Your other stopped tasks in this request");
      assert.match(listed[0]!, /^- gt:s6 \(failed, failed\): stopped job 6 x+…$/);
      assert.match(listed[4]!, /^- gt:s2 \(paused, stopped\)/);
      assert.notInclude(packet, "not hers");
      assert.notInclude(packet, "another request");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("routineScope says who wrote the request a member's task came from", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "@ada plan the launch" }, h.user);
    const user = yield* groups.member.routineScope({ callerThreadId: h.threadOf("ada") });
    assert.deepEqual(user, { teamId: TEAM, askedByUser: true });
    // A task handed on from the user's request still counts as the user's ask.
    yield* groups.member.assign({
      callerThreadId: h.threadOf("ada"),
      member: "beto",
      instruction: "Build",
    });
    assert.equal(
      (yield* groups.member.routineScope({ callerThreadId: h.threadOf("beto") })).askedByUser,
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
    const scope = yield* groups.member.routineScope({ callerThreadId: h.threadOf("ada") });
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

it.effect("two requests in different projects run together, each seeing only its own", () => {
  const h = harness({ projects: { ada: ["p1"], beto: ["p2"] } });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const core = yield* groups.post(
      { teamId: TEAM, text: "@ada fix the core cache", projectId: ProjectId.make("p1") },
      h.user,
    );
    const app = yield* groups.post(
      { teamId: TEAM, text: "@beto fix the app login", projectId: ProjectId.make("p2") },
      h.user,
    );
    assert.deepEqual([core.message.projectId, app.message.projectId], ["p1", "p2"]);
    assert.deepEqual(
      (yield* h.tasks).map((task) => [task.owner_id, task.status]),
      [
        ["ada", "running"],
        ["beto", "running"],
      ],
    );
    assert.deepEqual(
      h.launched.map((input) => [input.threadId, input.projectId]),
      [
        [requestThreadId("ada", TEAM, core.message.id), "p1"],
        [requestThreadId("beto", TEAM, app.message.id), "p2"],
      ],
    );
    const [ada, beto] = h.sent;
    assert.include(ada!.text, "core cache");
    assert.notInclude(ada!.text, "app login");
    assert.include(beto!.text, "app login");
    assert.notInclude(beto!.text, "core cache");
    // A project outside the group is refused before anything is stored.
    const refused = yield* groups
      .post({ teamId: TEAM, text: "@ada x", projectId: ProjectId.make("p9") }, h.user)
      .pipe(Effect.flip);
    assert.equal(refused.reason, "invalid");
    // With no lead, a request that names a member but no project cannot be placed.
    const unplaced = yield* groups.post({ teamId: TEAM, text: "@ada x" }, h.user).pipe(Effect.flip);
    assert.include(unplaced.message, "Pick the project for this request");
    assert.lengthOf(yield* h.messages, 2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("an outside assistant's post without a project takes none the group lacks", () => {
  const h = harness({
    members: ["ada", "cy"],
    lead: "ada",
    routable: [codex],
    projects: { ada: ["p1", "p2"], beto: ["p3"] },
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.agentPost({
      callerThreadId: ThreadId.make("assistant:beto:1"),
      group: TEAM,
      text: "check the site",
    });
    assert.isUndefined(posted.message.projectId);
  }).pipe(Effect.provide(h.layer));
});

it.effect("another group's projects do not let a member work in this group's requests", () => {
  const h = harness({ projects: { ada: ["p1"], beto: ["p3"] } });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    // Ada is in OTHER_TEAM, which lists Site; that reach stays in OTHER_TEAM's requests.
    yield* sql`UPDATE assistant_teams SET project_ids_json = '["p3"]' WHERE team_id = ${OTHER_TEAM}`;
    const posted = yield* groups.post(
      { teamId: TEAM, text: "@ada @beto fix the site", projectId: ProjectId.make("p3") },
      h.user,
    );
    assert.deepEqual(
      posted.tasks.map((task) => task.ownerId),
      ["beto"],
    );
    assert.include(
      (yield* h.messages).map((row) => row.text),
      "Ada cannot work in Site, so only Beto got this.",
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("only a member that may work in the request's project gets its work", () => {
  const h = harness({ projects: { ada: ["p1", "p2"], beto: ["p1"] } });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    const notices = () =>
      h.messages.pipe(
        Effect.map((rows) => rows.filter((row) => row.kind === "notice").map((row) => row.text)),
      );
    const app = ProjectId.make("p2");
    // Mentions: the members outside the project are left out, and the chat says why.
    const both = yield* groups.post(
      { teamId: TEAM, text: "@ada @beto fix the app", projectId: app },
      h.user,
    );
    assert.deepEqual(
      both.tasks.map((task) => task.ownerId),
      ["ada"],
    );
    yield* groups.post({ teamId: TEAM, text: "@beto fix the app", projectId: app }, h.user);
    assert.deepEqual(yield* notices(), [
      "Beto cannot work in Mobile App, so only Ada got this.",
      "Beto cannot work in Mobile App, so nobody got this. Send it again mentioning a member who works there.",
    ]);
    assert.deepEqual(
      h.launched.map((launch) => [launch.threadId.split(":")[1], launch.projectId]),
      [["ada", "p2"]],
    );
    // Hand-offs and reassigning refuse a member outside the project.
    const adaThread = requestThreadId("ada", TEAM, both.message.id);
    for (const refused of [
      groups.member.assign({ callerThreadId: adaThread, member: "beto", instruction: "test" }),
      groups.member.transfer({ callerThreadId: adaThread, member: "beto", note: "yours" }),
    ]) {
      assert.include((yield* Effect.flip(refused)).message, "Beto cannot work in");
    }
    yield* h.finishTask(both.tasks[0]!.id, "failed");
    const reassigned = yield* groups
      .taskAction({ taskId: both.tasks[0]!.id, action: "reassign", ownerId: "beto" as never })
      .pipe(Effect.flip);
    assert.include(reassigned.message, "Beto cannot work in");
    // A member whose list changed after it started is refused at launch too.
    const core = yield* groups.post(
      { teamId: TEAM, text: "@beto fix the core", projectId: ProjectId.make("p1") },
      h.user,
    );
    yield* h.finishTask(core.tasks[0]!.id, "failed");
    yield* sql`UPDATE assistants SET project_ids_json = '["p3"]' WHERE assistant_id = 'beto'`;
    yield* groups.post(
      { teamId: TEAM, text: "continue", replyToMessageId: core.message.id },
      h.user,
    );
    assert.deepEqual(
      (yield* h.tasks).find((task) => task.task_id === core.tasks[0]!.id)!.reason,
      "outside_project",
    );
    // An assistant held to its projects cannot post work into another one.
    const outside = yield* groups
      .agentPost({
        callerThreadId: ThreadId.make("assistant:beto:1"),
        group: TEAM,
        text: "@ada fix the app",
        project: "Mobile App",
      })
      .pipe(Effect.flip);
    assert.include(outside.message, "You are a project assistant");
    // With several projects and none named it must say which one.
    yield* sql`UPDATE assistants SET project_ids_json = '["p1","p3"]' WHERE assistant_id = 'beto'`;
    const unnamed = yield* groups
      .agentPost({
        callerThreadId: ThreadId.make("assistant:beto:1"),
        group: TEAM,
        text: "@ada check the core",
      })
      .pipe(Effect.flip);
    assert.include(unnamed.message, "You work in several projects");
    // With one, its work stays in that home project instead of going to the lead.
    yield* sql`UPDATE assistants SET project_ids_json = '["p1"]' WHERE assistant_id = 'beto'`;
    const home = yield* groups.agentPost({
      callerThreadId: ThreadId.make("assistant:beto:1"),
      group: TEAM,
      text: "@ada check the core",
    });
    assert.equal(home.message.projectId, "p1");
    // A project the group lists is one its members may work in, in this group's requests only.
    yield* sql`UPDATE assistant_teams SET project_ids_json = '["p3"]' WHERE team_id = ${TEAM}`;
    const site = yield* groups.post(
      { teamId: TEAM, text: "@beto fix the site", projectId: ProjectId.make("p3") },
      h.user,
    );
    assert.deepEqual(
      site.tasks.map((task) => task.ownerId),
      ["beto"],
    );
    assert.deepEqual(h.launched.at(-1)!.projectId, "p3");
    const elsewhere = yield* groups
      .post(
        { teamId: OTHER_TEAM, text: "@ada fix the site", projectId: ProjectId.make("p3") },
        h.user,
      )
      .pipe(Effect.flip);
    assert.include(elsewhere.message, "not one of the group's projects");
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { name: "the lead picks a member outside the project", pick: ["beto"], left: ["beto"] },
  { name: "the lead takes it outside its project", pick: ["beto", "ada"], left: ["beto"] },
] as const)("$name: the chat says who was left out", ({ pick, left }) => {
  const h = harness({
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p1"] },
    route: () => ({ assistantIds: pick, projectId: "p2" }),
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "fix the login on the phone" }, h.user);
    yield* groups.idle;
    const reached = pick.filter((id) => !left.includes(id as never));
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.owner_id),
      reached,
    );
    assert.deepInclude(
      (yield* h.messages).map((row) => [row.kind, row.assistant_id, row.text]),
      [
        "notice",
        "beto",
        reached.length === 0
          ? "Beto cannot work in Mobile App, so nobody got this. Send it again mentioning a member who works there."
          : "Beto cannot work in Mobile App, so only Ada got this.",
      ],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("the lead does not route a request nobody may work in any more", () => {
  const h = harness({
    members: ["ada", "beto"],
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p1"] },
    route: () => ({ assistantIds: ["ada"] }),
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    const app = yield* groups.post(
      { teamId: TEAM, text: "@ada fix the app", projectId: ProjectId.make("p2") },
      h.user,
    );
    yield* h.finishTask(app.tasks[0]!.id, "completed", "Fixed.");
    yield* sql`UPDATE assistants SET project_ids_json = '["p1"]' WHERE assistant_id = 'ada'`;
    // An agent's follow-up goes through the lead, which has nobody left to pick.
    yield* groups.post(
      { teamId: TEAM, text: "one more fix", replyToMessageId: app.message.id },
      { kind: "agent", assistantId: null, label: "Planner" },
    );
    yield* groups.idle;
    assert.lengthOf(h.routeCalls, 0);
    assert.lengthOf(yield* h.tasks, 1);
    assert.equal(
      (yield* h.messages).at(-1)!.text,
      "Nobody in the group can work in Mobile App, so nobody got this.",
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("a deleted project is never offered, picked nor inferred", () => {
  const h = harness({
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p1"] },
    route: () => ({ assistantIds: ["ada"] }),
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-02-01' WHERE project_id = 'p2'`;
    const refused = yield* groups
      .post({ teamId: TEAM, text: "@ada x", projectId: ProjectId.make("p2") }, h.user)
      .pipe(Effect.flip);
    assert.equal(refused.reason, "invalid");
    // The one live project is the request's without asking.
    const posted = yield* groups.post({ teamId: TEAM, text: "fix the login" }, h.user);
    yield* groups.idle;
    assert.equal(
      (yield* groups.history({ teamId: TEAM })).messages.find((m) => m.id === posted.message.id)!
        .projectId,
      "p1",
    );
    assert.deepEqual(
      h.launched.map((launch) => launch.projectId),
      ["p1"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("the dev keeps working in the request's conversation when QA hands work back", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const build = yield* groups.post({ teamId: TEAM, text: "@ada build the export" }, h.user);
    const other = yield* groups.post({ teamId: TEAM, text: "@ada price the plan" }, h.user);
    const devThread = requestThreadId("ada", TEAM, build.message.id);
    yield* h.finishTask(other.tasks[0]!.id, "completed", "Priced.");
    const review = yield* groups.member.assign({
      callerThreadId: devThread,
      member: "beto",
      instruction: "Test the export",
    });
    yield* h.finishTask(build.tasks[0]!.id, "completed", "Waiting on QA.");
    yield* h.finishTask(review.taskId, "completed", "Crashes on an empty file.");
    const back = h.sent.at(-1)!;
    assert.include(back.text, "- Beto (completed): Crashes on an empty file.");
    assert.equal(back.threadId, devThread);
    assert.notEqual(back.threadId, requestThreadId("ada", TEAM, other.message.id));
    assert.lengthOf(
      h.launched.filter((input) => input.threadId === devThread),
      1,
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("hand-off limits count per request: a loop pauses its own request only", () => {
  const h = harness();
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const loop = yield* groups.post({ teamId: TEAM, text: "@ada settle it" }, h.user);
    const logo = yield* groups.post({ teamId: TEAM, text: "@cy draw the logo" }, h.user);
    yield* play(h, { ...endlessLoop("assign"), cy: () => ({ answer: "Logo done" }) });
    const rows = yield* h.sqlRows<{
      task_id: string;
      owner_id: string;
      status: string;
      reason: string | null;
      request_id: string;
      hops: number;
      undelivered_hops: number;
    }>("SELECT * FROM assistant_group_tasks ORDER BY rowid");
    assert.deepEqual(
      rows.filter((row) => row.request_id === logo.message.id).map((row) => row.status),
      ["completed"],
    );
    assert.deepEqual(
      [
        ...new Set(
          rows
            .filter((row) => row.request_id === loop.message.id && row.status !== "completed")
            .map((row) => `${row.status}:${row.reason}`),
        ),
      ],
      ["paused:no_delivery"],
    );
    const root = () =>
      h
        .sqlRows<{ hops: number; undelivered_hops: number }>(
          `SELECT hops, undelivered_hops FROM assistant_group_tasks WHERE task_id = '${loop.tasks[0]!.id}'`,
        )
        .pipe(Effect.map((found) => found[0]!));
    const stuck = yield* root();
    assert.isAbove(stuck.undelivered_hops, 0);
    // The user acting in another request leaves this one's counts alone; acting in it clears them.
    yield* groups.post(
      { teamId: TEAM, text: "@cy and a favicon", replyToMessageId: logo.message.id },
      h.user,
    );
    assert.deepEqual(yield* root(), stuck);
    yield* groups.post(
      { teamId: TEAM, text: "continue", replyToMessageId: loop.message.id },
      h.user,
    );
    assert.deepEqual(yield* root(), { hops: 0, undelivered_hops: 0 });
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a request from before projects offers the lead every member, whatever its project",
  () => {
    const h = harness({
      lead: "beto",
      routable: [claude],
      projects: { ada: ["p2"], beto: ["p1"] },
      route: () => ({ assistantIds: ["beto"] }),
    });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      const posted = yield* groups.post(
        { teamId: TEAM, text: "@ada @cy fix the app", projectId: ProjectId.make("p2") },
        h.user,
      );
      // Two members work it, so a follow-up goes through the lead.
      yield* sql`UPDATE assistant_group_messages SET project_id = NULL`;
      yield* groups.post(
        { teamId: TEAM, text: "now the docs", replyToMessageId: posted.message.id },
        h.user,
      );
      yield* groups.idle;
      const call = h.routeCalls.at(-1) as { members: ReadonlyArray<{ id: string }> };
      assert.deepEqual(
        call.members.map((member) => member.id),
        ["ada", "beto", "cy"],
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "the lead picks the project of a new request, titles it, and its members work there",
  () => {
    const h = harness({
      lead: "beto",
      routable: [claude],
      projects: { ada: ["p1", "p2"], beto: ["p1"] },
      route: () => ({ assistantIds: ["ada"], projectId: "p2", title: "Fix the mobile login" }),
    });
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const posted = yield* groups.post(
        { teamId: TEAM, text: "the login breaks on my phone" },
        h.user,
      );
      yield* groups.idle;
      const call = h.routeCalls[0] as {
        projects: ReadonlyArray<{ id: string; name: string }>;
        newRequest: boolean;
      };
      assert.deepEqual(
        call.projects.map((project) => project.name),
        ["Core", "Mobile App"],
      );
      assert.isTrue(call.newRequest);
      const root = (yield* groups.history({ teamId: TEAM })).messages.find(
        (message) => message.id === posted.message.id,
      )!;
      assert.deepEqual([root.projectId, root.title], ["p2", "Fix the mobile login"]);
      assert.equal(h.launched[0]!.projectId, "p2");
      assert.include(h.sent[0]!.text, 'This task belongs to the request "Fix the mobile login".');
      assert.equal(
        (yield* h.messages).at(-1)!.text,
        "Beto (lead) picked Mobile App and routed it to Ada",
      );
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect.each([
  { name: "a text reply", via: "text" },
  { name: "a picked project", via: "project" },
] as const)("an unclear project makes the lead ask, and $name routes the request", ({ via }) => {
  let call = 0;
  const h = harness({
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p1"] },
    route: () => {
      call += 1;
      if (call === 1) return { assistantIds: [], question: "Core or the Mobile App?" };
      return via === "text"
        ? { assistantIds: ["ada"], projectId: "p1" }
        : { assistantIds: ["ada"] };
    },
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    const posted = yield* groups.post({ teamId: TEAM, text: "fix the login" }, h.user);
    yield* groups.idle;
    assert.lengthOf(yield* h.tasks, 0);
    const question = (yield* h.messages).at(-1)!;
    // The client reads this shape as a request waiting for its project.
    assert.deepInclude(question, {
      kind: "notice",
      author: "assistant",
      assistant_id: "beto",
      text: "Core or the Mobile App?",
      reply_to: posted.message.id,
    });
    // Reconciling later does not ask again.
    yield* groups.reconcile;
    yield* groups.idle;
    assert.lengthOf(h.routeCalls, 1);
    yield* groups.post(
      via === "text"
        ? { teamId: TEAM, text: "the core one", replyToMessageId: question.message_id as never }
        : {
            teamId: TEAM,
            text: "Mobile App",
            replyToMessageId: posted.message.id,
            projectId: ProjectId.make("p2"),
          },
      h.user,
    );
    yield* groups.idle;
    assert.lengthOf(h.routeCalls, 2);
    assert.include(
      (h.routeCalls[1] as { followUps: Array<{ text: string }> }).followUps.map((m) => m.text),
      via === "text" ? "the core one" : "Mobile App",
    );
    assert.deepEqual(
      (yield* h.tasks).map((task) => task.owner_id),
      ["ada"],
    );
    assert.equal(h.launched[0]!.projectId, via === "text" ? "p1" : "p2");
    // The task runs the request, not the answer.
    assert.include(h.sent[0]!.text, "Your task, from the user: fix the login");
  }).pipe(Effect.provide(h.layer));
});

it.effect("without a lead's answer the lead asks with the group's projects named", () => {
  const h = harness({
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p3"] },
    route: () => "fail",
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post({ teamId: TEAM, text: "fix the login" }, h.user);
    yield* groups.idle;
    assert.equal(
      (yield* h.messages).at(-1)!.text,
      "Which project is this for: Core, Mobile App or Site?",
    );
    assert.lengthOf(yield* h.tasks, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { name: "one #project picks it", text: "fix the login in #mobile-app", pick: null, runs: "p2" },
  { name: "an unknown #word leaves it to the lead", text: "fix #nope", pick: null, runs: "p1" },
  {
    name: "the picker wins over the text, and the lead says so",
    text: "fix the login in #core",
    pick: "p2",
    runs: "p2",
    notice: "Running this in Mobile App, the project you picked. The text also names Core.",
  },
  {
    name: "two #projects make the lead ask between them",
    text: "fix #core and #mobile-app",
    pick: null,
    runs: null,
    notice: "Which project is this for: Core or Mobile App?",
  },
] as const)("$name", ({ text, pick, runs, ...rest }) => {
  const h = harness({
    lead: "beto",
    routable: [claude],
    projects: { ada: ["p1", "p2"], beto: ["p3"] },
    route: () => ({ assistantIds: ["ada"], projectId: "p1" }),
  });
  return Effect.gen(function* () {
    const groups = yield* h.setup;
    yield* groups.post(
      { teamId: TEAM, text, ...(pick === null ? {} : { projectId: ProjectId.make(pick) }) },
      h.user,
    );
    yield* groups.idle;
    const notices = (yield* groups.history({ teamId: TEAM })).messages.filter(
      (message) => message.kind === "notice",
    );
    // Only the lead's question for the project carries the mark clients read as "Needs project".
    assert.deepEqual(
      notices.map((message) => [message.assistantId, message.text, message.asksProject ?? false]),
      "notice" in rest ? [["beto", rest.notice, runs === null]] : [],
    );
    assert.deepEqual(
      h.launched.map((launch) => launch.projectId),
      runs === null ? [] : [runs],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "a delivered request settles its conversations; a reply or a continue un-settles them first",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const request = yield* groups.post({ teamId: TEAM, text: "@ada @beto plan it" }, h.user);
      const ada = requestThreadId("ada", TEAM, request.message.id);
      const beto = requestThreadId("beto", TEAM, request.message.id);
      const commands = (type: string) =>
        h.dispatched.filter((command) => command.type === type).map((command) => command.threadId);
      yield* h.finish(0, "completed", "Ada's part");
      // Beto still works on it: nothing settles yet.
      assert.deepEqual(commands("thread.settle"), []);
      yield* h.finish(1, "completed", "Beto's part");
      assert.deepEqual(commands("thread.settle"), [ada, beto]);
      assert.equal(h.fakeThreads.get(beto)!.settledOverride, "settled");
      // Settling again is a no-op: settled threads are skipped.
      const before = commands("thread.settle").length;
      yield* groups.reconcile;
      assert.lengthOf(commands("thread.settle"), before);

      yield* groups.post(
        { teamId: TEAM, text: "@ada one more thing", replyToMessageId: request.message.id },
        h.user,
      );
      // Both conversations of the request are active again before Ada's task is sent.
      assert.deepEqual(commands("thread.unsettle"), [ada, beto]);
      assert.isNull(h.fakeThreads.get(beto)!.settledOverride);
      yield* h.finish(2, "completed", "Done too");
      assert.deepEqual(commands("thread.settle"), [ada, beto, ada, beto]);
      const answer = (yield* h.messages).findLast((row) => row.assistant_id === "ada")!;
      yield* groups.post(
        { teamId: TEAM, text: "continue", replyToMessageId: answer.message_id as never },
        h.user,
      );
      assert.deepEqual(commands("thread.unsettle"), [ada, beto, ada, beto]);
      assert.equal(h.sent.at(-1)!.threadId, ada);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a paused or failed request never settles; a cancelled one settles once its run ends",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const settled = () =>
        h.dispatched.filter((command) => command.type === "thread.settle").map((c) => c.threadId);
      const failed = yield* groups.post({ teamId: TEAM, text: "@ada one" }, h.user);
      yield* h.finish(0, "failed");
      const paused = yield* groups.post({ teamId: TEAM, text: "@beto two" }, h.user);
      yield* groups.taskAction({ taskId: paused.tasks[0]!.id, action: "stop" });
      yield* h.finishTask(paused.tasks[0]!.id, "interrupted");
      assert.deepEqual(
        (yield* h.tasks).map((task) => task.status),
        ["failed", "paused"],
      );
      assert.deepEqual(settled(), []);
      // Cancelled counts as delivered, but a turn still stopping settles only when its run ends.
      yield* groups.taskAction({ taskId: failed.tasks[0]!.id, action: "cancel" });
      const cancelled = yield* groups.post({ teamId: TEAM, text: "@cy three" }, h.user);
      yield* groups.taskAction({ taskId: cancelled.tasks[0]!.id, action: "stop" });
      yield* groups.taskAction({ taskId: cancelled.tasks[0]!.id, action: "cancel" });
      const cyThread = requestThreadId("cy", TEAM, cancelled.message.id);
      assert.notInclude(settled(), cyThread);
      yield* h.finishTask(cancelled.tasks[0]!.id, "interrupted");
      assert.include(settled(), cyThread);
      assert.include(settled(), requestThreadId("ada", TEAM, failed.message.id));
      assert.notInclude(settled(), requestThreadId("beto", TEAM, paused.message.id));
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "after the upgrade a run on a member's old group conversation still finishes its task",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      const legacy = groupThreadId("ada", TEAM);
      h.fakeThreads.set(legacy, {
        projectId: "p1",
        title: "Ada · Team team:1",
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        modelSelection: selection(codex, "ada-model"),
      });
      // As the migration leaves them: requests backfilled, the long conversation kept.
      yield* sql`INSERT INTO assistant_group_messages
      (message_id, team_id, seq, author, kind, text, request_id, created_at)
      VALUES ('gm:live', ${TEAM}, 1, 'user', 'message', '@ada live one', 'gm:live', '2026-01-01'),
        ('gm:stuck', ${TEAM}, 2, 'user', 'message', '@ada stuck one', 'gm:stuck', '2026-01-01')`;
      yield* sql`INSERT INTO assistant_group_tasks
      (task_id, team_id, root_id, kind, request_message_id, owner_id, instruction, status, reason,
       request_id, created_at, updated_at)
      VALUES ('gt:live', ${TEAM}, 'gt:live', 'root', 'gm:live', 'ada', 'live one', 'running', NULL,
          'gm:live', '2026-01-01', '2026-01-01'),
        ('gt:stuck', ${TEAM}, 'gt:stuck', 'root', 'gm:stuck', 'ada', 'stuck one', 'paused',
          'stopped', 'gm:stuck', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id, seen_seq)
      VALUES (${TEAM}, 'ada', ${legacy}, 2)`;
      const runMessage = taskMessageId("gt:live", 1);
      h.runs.set(legacy, [{ id: "run:legacy", userMessageId: runMessage, status: "completed" }]);
      h.answers.set("run:legacy", "Finished on the old thread.");
      yield* groups.handleRunEvent({
        type: "run.updated",
        payload: {
          id: "run:legacy",
          threadId: legacy,
          userMessageId: runMessage,
          status: "completed",
        },
      } as never as OrchestrationV2DomainEvent);
      const answer = (yield* h.messages).at(-1)!;
      assert.deepInclude(answer, { assistant_id: "ada", text: "Finished on the old thread." });
      assert.equal(
        (yield* h.sqlRows<{ request_id: string }>(
          `SELECT request_id FROM assistant_group_messages WHERE message_id = '${answer.message_id}'`,
        ))[0]!.request_id,
        "gm:live",
      );
      // A stopped task picked up again starts in its request's own conversation.
      const resumed = yield* groups.taskAction({ taskId: "gt:stuck" as never, action: "resume" });
      assert.equal(resumed.threadId, requestThreadId("ada", TEAM, "gm:stuck"));
      assert.equal(h.sent.at(-1)!.threadId, requestThreadId("ada", TEAM, "gm:stuck"));
      assert.include(h.sent.at(-1)!.text, "stuck one");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "a member waiting on the user shows once in its request and is marked resolved when answered",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const groups = yield* h.setup;
      const sql = yield* SqlClient.SqlClient;
      const deploy = yield* groups.post({ teamId: TEAM, text: "@ada deploy it" }, h.user);
      const thread = deploy.tasks[0]!.threadId;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('rr-1', ${thread}, 'n', 'command', 'pending', '2026-01-01', '{}'),
          ('rr-machine', ${thread}, 'n', 'auth_refresh', 'pending', '2026-01-01', '{}')`;
      h.runtimeRequests.set("rr-1", {
        request: { kind: "command", status: "pending", responseCapability: { type: "live" } },
        item: { type: "approval_request", prompt: "rm -rf build", reason: null },
      });
      const decision = (id: string, client: string, approval: string | null) => sql`
        INSERT INTO decisions (decision_id, from_thread_id, project_id, client_request_id,
          thread_title, title, context, options_json, status, approval_request_id, created_at)
        VALUES (${id}, ${thread}, 'p1', ${client}, 't', 'Which region?', 'Pick one.',
          '[{"id":"a","label":"EU"},{"id":"b","label":"US"}]', 'open', ${approval}, '2026-01-02')`;
      // The mirror of the approval and autonomy's own notice are the same wait, not new ones.
      yield* decision("d-mirror", "approval:rr-1", "rr-1");
      yield* decision("d-notice", "autonomy:needs-you:rr-1", null);
      const event = {
        type: "runtime-request.updated",
        threadId: thread,
        payload: {},
      } as never as OrchestrationV2DomainEvent;
      yield* groups.handleRunEvent(event);
      yield* groups.handleRunEvent(event);
      yield* decision("d-asked", "region", null);
      yield* groups.syncWaitingThread(thread);
      // A restart reconciles the same waits without posting them again.
      yield* groups.reconcile;
      const notices = () =>
        groups
          .history({ teamId: TEAM })
          .pipe(Effect.map((page) => page.messages.filter((m) => m.waiting !== undefined)));
      const posted = yield* notices();
      assert.deepEqual(
        posted.map((m): unknown[] => [m.kind, m.author, m.assistantId, m.requestId, m.waiting]),
        [
          ["notice", "assistant", "ada", deploy.message.id, { threadId: thread, resolved: false }],
          [
            "notice",
            "assistant",
            "ada",
            deploy.message.id,
            { threadId: thread, decisionId: "d-asked", resolved: false },
          ],
        ],
      );
      assert.include(posted[0]!.text, "rm -rf build");
      assert.include(posted[0]!.text, "Options:");
      assert.equal(posted[1]!.text, "Which region?\n\nPick one.\n\nOptions: EU · US");

      // Answered anywhere (here, straight in the store): the notices stay, marked resolved.
      yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved'
        WHERE runtime_request_id = 'rr-1'`;
      yield* groups.handleRunEvent(event);
      yield* sql`UPDATE decisions SET status = 'answered' WHERE decision_id = 'd-asked'`;
      yield* groups.reconcile;
      assert.deepEqual(
        (yield* notices()).map((m) => m.waiting?.resolved),
        [true, true],
      );
      // A thread that is no request's is left alone.
      yield* groups.syncWaitingThread(ThreadId.make("thread:outside"));
      assert.lengthOf(yield* notices(), 2);
    }).pipe(Effect.provide(h.layer));
  },
);
