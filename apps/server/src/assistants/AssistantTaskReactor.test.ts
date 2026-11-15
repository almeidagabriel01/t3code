import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type AssistantId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as NeedsUser from "../autonomy/NeedsUser.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import { requestDecision, waitWakeId } from "../autonomy/needsYou.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Reactor from "./AssistantTaskReactor.ts";
import * as Tasks from "./AssistantTasks.ts";
import { TaskEventNotices } from "./TaskEventNotices.ts";

const taskThread = ThreadId.make("thread-task");

const runEvent = (threadId: ThreadId, status: string, type = "run.updated", ordinal = 1) =>
  ({
    type,
    payload: { id: `run-${status}`, threadId, status, ordinal, userMessageId: "m1" },
  }) as never as OrchestrationV2DomainEvent;

const delegatedThread = ThreadId.make("thread-delegated");
const groupChild = ThreadId.make("thread-group-child");
const nativeChild = ThreadId.make("thread-native-child");
const taskWorker = ThreadId.make("thread-task-worker");

const requestChange = (
  threadId: ThreadId,
  kind: string,
  status = "pending",
  capability: "live" | "message" = "live",
) =>
  NeedsUser.requestWaitChange({
    type: "runtime-request.updated",
    threadId,
    payload: {
      id: `req-${kind}`,
      kind,
      status,
      createdAt: DateTime.makeUnsafe(0),
      responseCapability:
        capability === "live" ? { type: "live", providerSessionId: "s1" } : { type: "message" },
    },
  } as never);

const decisionChange = (status = "open", extra: Record<string, unknown> = {}) =>
  NeedsUser.decisionWaitChange({
    type: "upserted",
    decision: {
      id: "dec-1",
      fromThreadId: taskThread,
      threadTitle: "Add retry",
      title: "Names in the group chat UI",
      context: "Per request or per member?",
      options: [
        { id: "req", label: "Per request" },
        { id: "member", label: "Per member" },
      ],
      status,
      createdAt: "2026-01-02T00:00:00.000Z",
      ...extra,
    },
  } as never);

const ITEMS: Record<string, unknown> = {
  command: { type: "approval_request", prompt: "pnpm publish" },
  user_input: {
    type: "user_input_request",
    questions: [{ question: "Which name?", options: [{ label: "Ada" }, { label: "Bo" }] }],
  },
};

const plainThread = { lineage: { parentThreadId: null, relationshipToParent: null } };
const THREADS: Record<string, unknown> = {
  [taskWorker]: {
    title: "Worker",
    creationSource: "server",
    lineage: { parentThreadId: taskThread, relationshipToParent: "subagent" },
  },
  [delegatedThread]: {
    title: "Delegated fix",
    creationSource: "server",
    lineage: { parentThreadId: "assistant:ada:1", relationshipToParent: "subagent" },
  },
  [groupChild]: {
    title: "Group work",
    creationSource: "server",
    lineage: {
      parentThreadId: "assistant:ada:g-0123456789abcdef",
      relationshipToParent: "subagent",
    },
  },
  [nativeChild]: {
    title: "Native",
    creationSource: "provider",
    lineage: { parentThreadId: "assistant:ada:1", relationshipToParent: "subagent" },
  },
};

const harness = (
  options: {
    readonly failSend?: boolean;
    /** Keys whose wait no longer stands when the reactor reads it. */
    readonly settled?: ReadonlyArray<string>;
    readonly runs?: ReadonlyArray<Record<string, unknown>>;
    readonly pendingBackgroundTasks?: ReadonlyArray<Record<string, unknown>>;
    readonly changes?: ReadonlyArray<NeedsUser.UserWaitChange>;
  } = {},
) => {
  /** Wait wakes, sent straight to the conversation. */
  const sends: Array<Record<string, unknown>> = [];
  /** Run ends, offered to the notices door. */
  const notices: Array<Record<string, unknown>> = [];
  const folded: Array<string> = [];
  const allFolded = Deferred.makeUnsafe<void>();
  const dispatched: Array<Record<string, unknown>> = [];
  /** Lets a test await sends that a forked loop makes. */
  const onSend: { current: (input: unknown) => Effect.Effect<void> } = {
    current: () => Effect.void,
  };
  const records = (threadId: string) =>
    Effect.succeed({
      thread: THREADS[threadId] ?? plainThread,
      messages: [{ text: "Done: retry added" }, { text: "  " }],
      runs: options.runs ?? [],
    } as never);
  // The real owner chain, default lookup and withdrawal; only what waits is scripted.
  const needsUser = Layer.effect(
    NeedsUser.NeedsUser,
    Effect.gen(function* () {
      const real = yield* NeedsUser.NeedsUser;
      return NeedsUser.NeedsUser.of({
        ...real,
        changes: Stream.fromIterable(options.changes ?? []),
        describe: (wait, agent) =>
          Effect.succeed(
            options.settled?.includes(wait.key) === true
              ? Option.none()
              : wait.source === "decision"
                ? Option.some({
                    title: wait.decision.title,
                    context: wait.decision.context,
                    options: wait.decision.options,
                    answerable: true,
                  })
                : Option.some(
                    requestDecision(
                      agent,
                      {
                        kind: wait.requestKind,
                        responseCapability: { type: "live", providerSessionId: "s1" },
                      } as never,
                      ITEMS[wait.requestKind] as never,
                    ),
                  ),
          ),
      });
    }),
  ).pipe(
    Layer.provide(NeedsUser.layer),
    Layer.provide(Layer.mock(DecisionService.DecisionService)({})),
    Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
  );
  const layer = Reactor.layer.pipe(
    Layer.provideMerge(needsUser),
    Layer.provideMerge(Tasks.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          getThreadShell: () =>
            Effect.succeed({
              title: "Add retry",
              archivedAt: null,
              pendingBackgroundTasks: options.pendingBackgroundTasks ?? [],
            } as never),
          getThreadRecords: records,
          dispatch: (command) =>
            Effect.sync(() => void dispatched.push(command as never)).pipe(Effect.as({} as never)),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: records,
          sendToThread: (input) =>
            options.failSend === true
              ? Effect.fail(new Error("send failed") as never)
              : Effect.sync(() => void sends.push(input as never)).pipe(
                  Effect.andThen(onSend.current(input)),
                  Effect.as({} as never),
                ),
        }),
        Layer.mock(TaskEventNotices)({
          send: (notice) =>
            options.failSend === true
              ? Effect.succeed("failed" as const)
              : Effect.sync(() => {
                  notices.push(notice as never);
                  return "sent" as const;
                }),
          foldQueued: (threadId) =>
            Effect.suspend(() => {
              folded.push(threadId);
              return folded.length === 2 ? Deferred.succeed(allFolded, undefined) : Effect.void;
            }),
        }),
      ),
    ),
  );
  return { sends, notices, folded, allFolded, dispatched, onSend, layer };
};

const insertAssistant = (id: string, archived = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, archived_at, created_at, updated_at)
      VALUES (${id}, ${id}, ${id}, 'assistants-home', 'full', ${`assistant:${id}:1`},
        ${archived ? "now" : null}, '2026-01-01', '2026-01-01')`;
  });

/** Ada, an assistant like any other, launched the task thread; group threads use the real table. */
const setupAda = (archived = false) =>
  Effect.gen(function* () {
    yield* insertAssistant("ada", archived);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistant_group_threads (team_id, assistant_id, thread_id)
      VALUES ('team-1', 'ada', 'assistant:ada:g-0123456789abcdef')`;
    yield* (yield* Tasks.AssistantTasks).link({
      threadId: taskThread,
      assistantId: "ada" as AssistantId,
      projectId: ProjectId.make("p1"),
      title: "Add retry",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  });

const setup = (archived = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO assistants
        (assistant_id, handle, name, project_id, tool_access, thread_id, archived_at, created_at, updated_at)
      VALUES ('jarvis', 'jarvis', 'Jarvis', 'assistants-home', 'full', 'assistant:jarvis:1',
        ${archived ? "now" : null}, '2026-01-01', '2026-01-01')`;
    yield* (yield* Tasks.AssistantTasks).link({
      threadId: taskThread,
      assistantId: "jarvis" as AssistantId,
      projectId: ProjectId.make("p1"),
      title: "Add retry",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
  });

it.effect(
  "a task run that ends is offered to its assistant through the notices door, with its last message",
  () => {
    const { notices: sends, layer } = harness();
    return Effect.gen(function* () {
      yield* setup();
      const reactor = yield* Reactor.AssistantTaskReactor;
      yield* reactor.handle(runEvent(taskThread, "completed"));
      yield* reactor.handle(runEvent(taskThread, "completed", "run.created"));
      assert.strictEqual(sends.length, 2);
      const [sent] = sends;
      // Both events name the same run, so they offer the same message id; the door tells it once.
      assert.strictEqual(sends[0]?.messageId, sends[1]?.messageId);
      assert.strictEqual(sent?.messageId, "assistant-task:run-completed");
      assert.strictEqual(sent?.threadId, "assistant:jarvis:1");
      // The send targets the assistant's thread, so it names the assistant's project, not the task's.
      assert.strictEqual(sent?.projectId, "assistants-home");
      assert.strictEqual(sent?.senderThreadId, taskThread);
      assert.strictEqual((sent?.run as { id: string } | undefined)?.id, "run-completed");
      const text = String(sent?.text);
      assert.include(text, "finished");
      assert.include(text, "Done: retry added");
      assert.include(text, "t3_thread_send");
      assert.include(text, "NO_REPLY");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a failed run says so", () => {
  const { notices: sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "failed"));
    assert.include(String(sends[0]?.text), "failed");
  }).pipe(Effect.provide(layer));
});

it.effect("a run still going, another thread, and an archived assistant wake no one", () => {
  const { notices: sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setup(true);
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* reactor.handle(runEvent(taskThread, "running"));
    yield* reactor.handle(runEvent(ThreadId.make("thread-plain"), "completed"));
    yield* reactor.handle(runEvent(taskThread, "completed"));
    yield* reactor.handle({ type: "thread.created", threadId: taskThread } as never);
    assert.strictEqual(sends.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("a wake that cannot be sent is logged and does not stop the reactor", () => {
  const { layer } = harness({ failSend: true });
  return Effect.gen(function* () {
    yield* setup();
    yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "completed"));
  }).pipe(Effect.provide(layer));
});

it.effect("starting folds the backlog of every active assistant thread", () => {
  const { folded, allFolded, layer } = harness();
  return Effect.gen(function* () {
    yield* setup();
    yield* insertAssistant("second");
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* Effect.scoped(reactor.start().pipe(Effect.andThen(Deferred.await(allFolded))));
    assert.sameMembers(folded, ["assistant:jarvis:1", "assistant:second:1"]);
  }).pipe(Effect.provide(layer));
});

it("the wake text names the outcome and works without a last message", () => {
  const text = Reactor.taskWakeText({
    title: "Add retry",
    threadId: taskThread,
    status: "interrupted",
    lastMessage: null,
  });
  assert.include(text, "interrupted");
  assert.notInclude(text, "last message");
});

it.effect("a task that waits on an approval wakes its assistant once, with the options", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setupAda();
    const reactor = yield* Reactor.AssistantTaskReactor;
    const change = requestChange(taskThread, "command")!;
    yield* reactor.handleWait(change);
    // A replayed event sends under the same command id, which the orchestrator runs once.
    yield* reactor.handleWait(change);
    assert.strictEqual(sends.length, 2);
    assert.strictEqual(sends[0]?.commandId, sends[1]?.commandId);
    const [sent] = sends;
    assert.strictEqual(sent?.messageId, `assistant-task-waits:assistant:ada:1:request:req-command`);
    assert.strictEqual(sent?.threadId, "assistant:ada:1");
    assert.strictEqual(sent?.projectId, "assistants-home");
    assert.strictEqual(sent?.senderThreadId, taskThread);
    const text = String(sent?.text);
    assert.include(text, "wants to run a command");
    assert.include(text, "pnpm publish");
    assert.include(text, "Options: Approve / Deny");
    assert.include(text, "Never approve");
  }).pipe(Effect.provide(layer));
});

it.effect("a question wakes with its options and a decision points to Activity", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setupAda();
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* reactor.handleWait(requestChange(taskThread, "user_input")!);
    yield* reactor.handleWait(decisionChange()!);
    assert.strictEqual(sends.length, 2);
    const question = String(sends[0]?.text);
    assert.include(question, "Which name?");
    assert.include(question, "Options: Ada / Bo");
    const decision = String(sends[1]?.text);
    assert.strictEqual(sends[1]?.messageId, "assistant-task-waits:assistant:ada:1:decision:dec-1");
    assert.include(decision, "Names in the group chat UI");
    assert.include(decision, "Options: Per request / Per member");
    assert.include(decision, "in Activity");
  }).pipe(Effect.provide(layer));
});

it.effect("a delegate_task child of an assistant wakes it for approvals, not questions", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setupAda();
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* reactor.handleWait(requestChange(delegatedThread, "command")!);
    // DelegatedTaskQuestionReactor already brings the question to the parent.
    yield* reactor.handleWait(requestChange(delegatedThread, "user_input")!);
    // A group member's delegate and a provider-native subagent follow their own paths.
    yield* reactor.handleWait(requestChange(groupChild, "command")!);
    yield* reactor.handleWait(requestChange(nativeChild, "command")!);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0]?.threadId, "assistant:ada:1");
    assert.strictEqual(sends[0]?.senderThreadId, delegatedThread);
  }).pipe(Effect.provide(layer));
});

it.effect("a worker the task delegated to wakes the task's assistant, through the chain", () => {
  const { sends, layer } = harness();
  return Effect.gen(function* () {
    yield* setupAda();
    const reactor = yield* Reactor.AssistantTaskReactor;
    yield* reactor.handleWait(requestChange(taskWorker, "command")!);
    // Its question goes to the task's own agent first.
    yield* reactor.handleWait(requestChange(taskWorker, "user_input")!);
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0]?.threadId, "assistant:ada:1");
    assert.strictEqual(sends[0]?.senderThreadId, taskWorker);
  }).pipe(Effect.provide(layer));
});

it.effect("no wake for an archived owner, an assistant thread, or a wait already settled", () => {
  const archived = harness();
  const settled = harness({ settled: ["request:req-command"] });
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* setupAda(true);
      const reactor = yield* Reactor.AssistantTaskReactor;
      yield* reactor.handleWait(requestChange(taskThread, "command")!);
      yield* reactor.handleWait(decisionChange()!);
    }).pipe(Effect.provide(archived.layer));
    yield* Effect.gen(function* () {
      yield* setupAda();
      const reactor = yield* Reactor.AssistantTaskReactor;
      yield* reactor.handleWait(requestChange(taskThread, "command")!);
      yield* reactor.handleWait(requestChange(ThreadId.make("assistant:ada:1"), "user_input")!);
      yield* reactor.handleWait(requestChange(ThreadId.make("thread-plain"), "command")!);
    }).pipe(Effect.provide(settled.layer));
    assert.strictEqual(archived.sends.length + settled.sends.length, 0);
  });
});

it.effect(
  "a wait settled while its wake is queued takes the wake back, under its old id too",
  () => {
    const id = "assistant-task-waits:assistant:ada:1:request:req-command";
    // Queued before the id named the conversation woken instead of the thread that waits.
    const legacy = "assistant-task-waits:thread-task:request:req-command";
    const { sends, dispatched, layer } = harness({
      runs: [
        { id: "run-other", status: "queued", userMessageId: "m-other" },
        { id: "run-wake", status: "queued", userMessageId: id },
        { id: "run-legacy", status: "queued", userMessageId: legacy },
      ],
    });
    return Effect.gen(function* () {
      yield* setupAda();
      yield* (yield* Reactor.AssistantTaskReactor).handleWait(
        requestChange(taskThread, "command", "resolved")!,
      );
      assert.strictEqual(sends.length, 0);
      assert.deepStrictEqual(dispatched, [
        {
          type: "queued-run.cancel",
          commandId: `${id}:cancel`,
          threadId: "assistant:ada:1",
          runId: "run-wake",
        },
        {
          type: "queued-run.cancel",
          commandId: `${legacy}:cancel`,
          threadId: "assistant:ada:1",
          runId: "run-legacy",
        },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a settled wait also takes back the default assistant's queued notice", () => {
  const ada = "assistant-task-waits:assistant:ada:1:decision:dec-1";
  const jarvis = "assistant-task-waits:assistant:jarvis:1:decision:dec-1";
  const { sends, dispatched, layer } = harness({
    runs: [
      { id: "run-ada", status: "queued", userMessageId: ada },
      { id: "run-jarvis", status: "queued", userMessageId: jarvis },
    ],
  });
  return Effect.gen(function* () {
    yield* setupAda();
    yield* insertAssistant("jarvis");
    yield* (yield* Reactor.AssistantTaskReactor).handleWait(decisionChange("answered")!);
    assert.strictEqual(sends.length, 0);
    assert.deepStrictEqual(
      dispatched.map((command) => [command.threadId, command.runId]),
      [
        ["assistant:ada:1", "run-ada"],
        ["assistant:jarvis:1", "run-jarvis"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "the default's own task wakes it under the id its notice uses, so it is told once",
  () => {
    const { sends, layer } = harness();
    return Effect.gen(function* () {
      yield* setup();
      yield* (yield* Reactor.AssistantTaskReactor).handleWait(
        requestChange(taskThread, "command")!,
      );
      assert.strictEqual(sends[0]?.threadId, "assistant:jarvis:1");
      assert.strictEqual(
        sends[0]?.messageId,
        waitWakeId(ThreadId.make("assistant:jarvis:1"), "request:req-command"),
      );
    }).pipe(Effect.provide(layer));
  },
);

it("machine requests, notices and approval mirrors never count as waiting on the user", () => {
  assert.isNull(requestChange(taskThread, "dynamic_tool_call"));
  assert.isNull(requestChange(taskThread, "auth_refresh"));
  assert.isNull(decisionChange("open", { notice: true }));
  assert.isNull(decisionChange("open", { approvalRequestId: "req-command" }));
  assert.strictEqual(requestChange(taskThread, "command", "resolved")?.type, "resolved");
  assert.strictEqual(decisionChange("answered")?.type, "resolved");
  assert.isNull(NeedsUser.decisionWaitChange({ type: "snapshot", decisions: [] } as never));
});

it.effect("a run that ends while its thread resumes by itself does not report finished", () => {
  const parked = (pendingBackgroundTasks: ReadonlyArray<Record<string, unknown>>) =>
    harness({ pendingBackgroundTasks });
  const subagent = parked([{ taskId: "t1", kind: "subagent" }]);
  const awaited = parked([{ taskId: "t2", kind: "command", awaited: true }]);
  const queued = harness({
    runs: [
      { id: "run-completed", ordinal: 1, status: "completed" },
      { id: "run-next", ordinal: 2, status: "queued" },
    ],
  });
  const failedWithWork = parked([{ taskId: "t1", kind: "subagent" }]);
  return Effect.gen(function* () {
    for (const h of [subagent, awaited, queued]) {
      yield* Effect.gen(function* () {
        yield* setupAda();
        yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "completed"));
      }).pipe(Effect.provide(h.layer));
      assert.strictEqual(h.notices.length, 0);
    }
    // A failure always reports, whatever it left behind.
    yield* Effect.gen(function* () {
      yield* setupAda();
      yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "failed"));
    }).pipe(Effect.provide(failedWithWork.layer));
    assert.strictEqual(failedWithWork.notices.length, 1);
  });
});

it.effect(
  "a dev server left running, a PR watch or an older live run do not hold the report",
  () => {
    const h = harness({
      pendingBackgroundTasks: [
        { taskId: "dev", kind: "command" },
        { taskId: "pull-request-watch:github.com/acme/app#7", kind: "monitor", awaited: true },
      ],
      runs: [
        { id: "run-old", ordinal: 0, status: "waiting" },
        { id: "run-completed", ordinal: 1, status: "completed" },
      ],
    });
    return Effect.gen(function* () {
      yield* setupAda();
      yield* (yield* Reactor.AssistantTaskReactor).handle(runEvent(taskThread, "completed"));
      assert.strictEqual(h.notices.length, 1);
      assert.include(String(h.notices[0]?.text), "finished");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("start wakes for what already waits, and a second start repeats the same ids", () => {
  // `changes` opens with what waits at subscription; NeedsUser.test covers that ordering.
  const h = harness({
    changes: [requestChange(taskThread, "command")!, decisionChange()!],
  });
  return Effect.gen(function* () {
    yield* setupAda();
    const sent = yield* Queue.unbounded<unknown>();
    h.onSend.current = (input) => Queue.offer(sent, input).pipe(Effect.asVoid);
    const reactor = yield* Reactor.AssistantTaskReactor;
    const startAndAwaitTwoWakes = Effect.scoped(
      reactor.start().pipe(Effect.andThen(Queue.take(sent)), Effect.andThen(Queue.take(sent))),
    );
    yield* startAndAwaitTwoWakes;
    yield* startAndAwaitTwoWakes;
    assert.strictEqual(h.sends.length, 4);
    // The orchestrator's command receipts run each command id once, so a restart adds no wake.
    const ids = h.sends.map((input) => String(input.commandId));
    assert.deepStrictEqual(new Set(ids), new Set(ids.slice(0, 2)));
    assert.deepStrictEqual(ids.slice(0, 2).toSorted(), [
      "assistant-task-waits:assistant:ada:1:decision:dec-1",
      "assistant-task-waits:assistant:ada:1:request:req-command",
    ]);
  }).pipe(Effect.provide(h.layer));
});
