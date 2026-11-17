import { assert, describe, it } from "@effect/vitest";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type {
  AssistantGroupMessage,
  AssistantGroupMessageId,
  AssistantGroupTask,
  AssistantGroupsEvent,
  AssistantId,
  AssistantTeamChatScope,
  AssistantTeamId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  assistantGroupActivity,
  assistantGroupInScope,
  assistantGroupChatWaiting,
  assistantGroupTabs,
  assistantGroupTabsPending,
  assistantGroupTabView,
  assistantGroupProjectLabel,
  assistantGroupTabAfterSend,
  assistantGroupShownOutgoing,
  assistantGroupHeldAttachments,
  createAssistantGroupOutgoingStore,
  assistantGroupSendRequestId,
  assistantGroupComposerProjects,
  assistantGroupComposerProject,
  assistantGroupComposerModel,
  assistantGroupTabPick,
  resolveAssistantGroupTab,
  assistantGroupWorkedLabel,
  assistantGroupAnswerRoot,
  applyAssistantGroupHistory,
  applyAssistantGroupsEvent,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupBoundaryLabel,
  assistantGroupFeed,
  assistantGroupFinished,
  assistantGroupFinishedInView,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  assistantGroupRequestProject,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupAllReadSeq,
  assistantGroupReadStep,
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupProjectOptions,
  assistantGroupProjectQuery,
  assistantGroupMessageExcerpt,
  insertAssistantGroupProject,
  ASSISTANT_MENTION_HREF,
  assistantGroupMarkdownMentions,
  assistantGroupMentionHref,
  assistantGroupMentionTarget,
  assistantGroupMentionTargets,
  assistantGroupTaskReasonLabel,
  assistantGroupWaitingThreadIds,
  assistantGroupWaitingThreadsLabel,
  assistantGroupLeadCanRoute,
  assistantGroupRecipientsPreview,
  assistantGroupRunningCount,
  assistantGroupSendContext,
  assistantGroupSendContextEqual,
  insertAssistantGroupMention,
  oldestAssistantGroupSeq,
  type AssistantGroupChatState,
  type AssistantGroupTabKey,
} from "./assistantGroupChat.ts";

const message = (seq: number, overrides: Partial<AssistantGroupMessage> = {}) =>
  ({
    id: `m${seq}`,
    teamId: "t" as AssistantTeamId,
    seq,
    author: "user",
    assistantId: null,
    authorLabel: null,
    kind: "message",
    text: `text ${seq}`,
    replyToMessageId: null,
    taskId: null,
    createdAt: `2026-11-01T00:00:0${seq}.000Z`,
    ...overrides,
  }) as AssistantGroupMessage;

const task = (id: string, request: number, overrides: Partial<AssistantGroupTask> = {}) =>
  ({
    id,
    teamId: "t" as AssistantTeamId,
    rootId: id,
    parentId: null,
    kind: "root",
    requestMessageId: `m${request}`,
    ownerId: "ada" as AssistantId,
    instruction: "do it",
    status: "running",
    reason: null,
    threadId: "assistant:ada:g-0000000000000000" as ThreadId,
    createdAt: `2026-11-01T00:00:0${request}.000Z`,
    updatedAt: `2026-11-01T00:00:0${request}.000Z`,
    ...overrides,
  }) as AssistantGroupTask;

const snapshot = (
  messages: AssistantGroupMessage[],
  tasks: AssistantGroupTask[],
  hasMore = false,
): AssistantGroupsEvent => ({ type: "snapshot", messages, tasks, hasMore });

const start = (event: AssistantGroupsEvent) => {
  const state = applyAssistantGroupsEvent(null, event);
  assert.isNotNull(state);
  return state as AssistantGroupChatState;
};

describe("group chat state", () => {
  it("ignores changes before the snapshot, then upserts by id and keeps the newer task", () => {
    assert.isNull(applyAssistantGroupsEvent(null, { type: "message", message: message(1) }));
    let state = start(snapshot([message(2), message(1)], [task("k", 1)], true));
    assert.isTrue(state.hasMore);
    state = applyAssistantGroupsEvent(state, {
      type: "message",
      message: message(1, { text: "edited" }),
    })!;
    assert.strictEqual(state.messages.get("m1" as never)!.text, "edited");
    const newer = task("k", 1, { status: "completed", updatedAt: "2026-11-01T00:00:09.000Z" });
    state = applyAssistantGroupsEvent(state, { type: "task", task: newer })!;
    state = applyAssistantGroupsEvent(state, { type: "task", task: task("k", 1) })!;
    assert.strictEqual(state.tasks.get("k" as never)!.status, "completed");
    assert.strictEqual(assistantGroupRunningCount(state), 0);
  });

  it("merges an older page without duplicating or overwriting, and tracks what is left", () => {
    const state = start(snapshot([message(3)], [task("k", 3, { status: "paused" })], true));
    assert.strictEqual(oldestAssistantGroupSeq(state), 3);
    const merged = applyAssistantGroupHistory(state, {
      messages: [message(2), message(3, { text: "stale" })],
      tasks: [task("k", 3), task("j", 2)],
      hasMore: false,
    });
    assert.deepStrictEqual([...merged.messages.values()].map((entry) => entry.seq).sort(), [2, 3]);
    assert.strictEqual(merged.messages.get("m3" as never)!.text, "text 3");
    assert.strictEqual(merged.tasks.get("k" as never)!.status, "paused");
    assert.strictEqual(merged.tasks.size, 2);
    assert.isFalse(merged.hasMore);
    assert.isNull(
      oldestAssistantGroupSeq({
        messages: new Map(),
        tasks: new Map(),
        hasMore: false,
        requests: new Map(),
      }),
    );
    // After a clear nothing of an earlier page comes back, even once new messages arrive.
    const cleared = start(snapshot([], [], false));
    const page = { messages: [message(2)], tasks: [], hasMore: false };
    assert.strictEqual(applyAssistantGroupHistory(cleared, page).messages.size, 0);
    const restarted = start(snapshot([message(1, { id: "fresh" } as never)], [], false));
    assert.strictEqual(applyAssistantGroupHistory(restarted, page).messages.size, 1);
  });
});

describe("group requests", () => {
  const core = "p-core" as ProjectId;
  const site = "p-site" as ProjectId;
  const inRequest = (
    seq: number,
    request: number,
    overrides: Partial<AssistantGroupMessage> = {},
  ) => message(seq, { requestId: `m${request}` as never, ...overrides });

  it("keeps off-page request roots apart, updates them in place and folds them into a page", () => {
    const root = inRequest(1, 1, { projectId: core, title: "Fix login" });
    let state = start({
      type: "snapshot",
      messages: [inRequest(5, 1, { author: "assistant", assistantId: "ada" as AssistantId })],
      tasks: [],
      hasMore: true,
      requests: [root],
    });
    assert.strictEqual(oldestAssistantGroupSeq(state), 5);
    state = applyAssistantGroupsEvent(state, {
      type: "message",
      message: { ...root, title: "Fix the login" },
    })!;
    assert.strictEqual(state.requests.get("m1" as never)!.title, "Fix the login");
    assert.isFalse(state.messages.has("m1" as never));
    // A root older than the page that comes again (its project was set) stays out of the page too.
    state = applyAssistantGroupsEvent(state, {
      type: "message",
      message: inRequest(2, 2, { projectId: site }),
    })!;
    assert.isTrue(state.requests.has("m2" as never));
    assert.strictEqual(oldestAssistantGroupSeq(state), 5);
    // A request's project comes from its root, on the page or off it; none without a request.
    assert.strictEqual(assistantGroupRequestProject(state, "m2" as never), site);
    assert.strictEqual(assistantGroupRequestProject(state, "m1" as never), core);
    assert.isNull(assistantGroupRequestProject(state, undefined));
    assert.isNull(assistantGroupRequestProject(state, "m9" as never));
    const merged = applyAssistantGroupHistory(state, {
      messages: [root, inRequest(3, 3)],
      tasks: [],
      hasMore: false,
      requests: [inRequest(2, 2), inRequest(3, 3)],
    });
    assert.deepStrictEqual([...merged.requests.keys()], ["m2"]);
    assert.strictEqual(merged.requests.get("m2" as never)!.projectId, site);
    assert.isTrue(merged.messages.has("m1" as never));
  });

  it("cuts the feed into requests ordered by latest activity, with loose lines in place", () => {
    const state = start({
      type: "snapshot",
      messages: [
        inRequest(1, 1, { projectId: core, title: "Fix login" }),
        inRequest(2, 2, { projectId: site }),
        message(3, { kind: "change", author: "agent", text: "renamed" }),
        inRequest(4, 1, {
          author: "assistant",
          assistantId: "ada" as AssistantId,
          taskId: "a" as never,
        }),
        message(5, { kind: "boundary", text: "new" }),
      ],
      tasks: [
        task("a", 1, { requestId: "m1" as never, status: "completed" }),
        task("b", 2, { status: "running" }),
      ],
      hasMore: false,
      requests: [],
    });
    const feed = assistantGroupRequestFeed(state);
    assert.deepStrictEqual(
      feed.map((item) =>
        item.kind === "request"
          ? [item.block.requestId, item.block.title, item.block.status, item.block.rows.length]
          : [item.row.message.seq, item.row.role],
      ),
      [
        ["m2", "text 2", "working", 1],
        [3, "note"],
        ["m1", "Fix login", "done", 2],
        [5, "boundary"],
      ],
    );
  });

  it.each([
    { name: "routing", tasks: [], extra: [], status: "routing" },
    {
      name: "a lead question without a project",
      tasks: [],
      extra: [
        inRequest(2, 1, {
          kind: "notice",
          author: "assistant",
          text: "Which project?",
          replyToMessageId: "m1" as never,
          asksProject: true,
        }),
      ],
      status: "needs-project",
    },
    {
      name: "another lead notice without a project",
      tasks: [],
      extra: [
        inRequest(2, 1, {
          kind: "notice",
          author: "assistant",
          text: "I could not route this.",
          replyToMessageId: "m1" as never,
        }),
      ],
      status: "done",
    },
    {
      name: "a muted no-reply line",
      tasks: [],
      extra: [inRequest(2, 1, { kind: "routing", replyToMessageId: "m1" as never })],
      status: "done",
    },
    {
      name: "a task waiting on threads it opened",
      tasks: [task("a", 1, { status: "waiting", reason: "threads:t-1,t-2" })],
      extra: [],
      status: "working",
    },
    {
      name: "a paused task",
      tasks: [task("a", 1, { status: "paused" })],
      extra: [],
      status: "needs-you",
    },
    {
      name: "a failed task",
      tasks: [task("a", 1, { status: "failed" })],
      extra: [],
      status: "needs-you",
    },
    {
      name: "a task held by a usage limit",
      tasks: [task("a", 1, { status: "usage_limited" })],
      extra: [],
      status: "working",
    },
    {
      name: "a member waiting on the user while it works",
      tasks: [task("a", 1, { status: "running" })],
      extra: [
        inRequest(2, 1, {
          kind: "notice",
          author: "assistant",
          waiting: { threadId: "assistant:ada:g-0000000000000000" as ThreadId, resolved: false },
        }),
      ],
      status: "needs-you",
    },
    {
      name: "a waiting notice answered since",
      tasks: [task("a", 1, { status: "running" })],
      extra: [
        inRequest(2, 1, {
          kind: "notice",
          author: "assistant",
          waiting: { threadId: "assistant:ada:g-0000000000000000" as ThreadId, resolved: true },
        }),
      ],
      status: "working",
    },
    {
      name: "only cancelled tasks",
      tasks: [task("a", 1, { status: "cancelled" })],
      extra: [],
      status: "cancelled",
    },
    {
      name: "a queued and a completed task",
      tasks: [task("a", 1, { status: "completed" }), task("b", 1, { status: "queued" })],
      extra: [],
      status: "working",
    },
  ] as const)("a request with $name reads $status", ({ tasks, extra, status }) => {
    const state = start({
      type: "snapshot",
      messages: [inRequest(1, 1), ...extra],
      tasks: [...tasks],
      hasMore: false,
    });
    const [item] = assistantGroupRequestFeed(state);
    assert.strictEqual(item!.kind === "request" && item!.block.status, status);
  });

  it("names a request by its title, else its text without mentions, else a placeholder", () => {
    const long = "x".repeat(90);
    const state = start({
      type: "snapshot",
      messages: [
        inRequest(1, 1, { text: "\n@ada, @beto: check the totals\nmore" }),
        inRequest(2, 2, { text: long }),
        inRequest(3, 9),
        inRequest(4, 4, { text: "@ada" }),
      ],
      tasks: [],
      hasMore: false,
    });
    assert.deepStrictEqual(
      assistantGroupRequestFeed(state).map((item) => item.kind === "request" && item.block.title),
      ["check the totals", `${"x".repeat(79)}…`, "Earlier request", "Request"],
    );
  });

  it("opens a block that needs attention, holds unread news or is the newest", () => {
    const state = start({
      type: "snapshot",
      messages: [
        inRequest(1, 1),
        inRequest(2, 1, { author: "assistant", assistantId: "ada" as AssistantId }),
      ],
      tasks: [task("a", 1, { status: "completed" })],
      hasMore: false,
    });
    const [item] = assistantGroupRequestFeed(state);
    const block = item!.kind === "request" ? item!.block : null;
    assert.isTrue(assistantGroupRequestExpanded(block!, 0, false));
    assert.isFalse(assistantGroupRequestExpanded(block!, 2, false));
    assert.isTrue(assistantGroupRequestExpanded(block!, 2, true));
    assert.isTrue(assistantGroupRequestExpanded({ ...block!, status: "needs-you" }, 2, false));
  });
});

describe("group feed", () => {
  it("puts an open task under its request and an answered one on the latest answer", () => {
    const state = start(
      snapshot(
        [
          message(4, { author: "assistant", kind: "routing", text: "routed" }),
          message(1),
          message(2, {
            author: "assistant",
            assistantId: "ada" as AssistantId,
            taskId: "a" as never,
          }),
          message(3, {
            author: "assistant",
            assistantId: "ada" as AssistantId,
            taskId: "a" as never,
          }),
          message(5, { author: "assistant", kind: "notice" }),
          message(6, { kind: "boundary", text: "compact" }),
          message(7, { author: "assistant", kind: "change", text: "Ada added Bo" }),
        ],
        [
          task("a", 1),
          task("b", 1, { ownerId: "bo" as AssistantId, createdAt: "2026-11-01T00:00:05.000Z" }),
        ],
      ),
    );
    const rows = assistantGroupFeed(state);
    assert.deepStrictEqual(
      rows.map((row) => [row.message.seq, row.role, row.tasks.map((entry) => entry.id)]),
      [
        [1, "request", ["b"]],
        [2, "answer", []],
        [3, "answer", ["a"]],
        [4, "note", []],
        [5, "note", []],
        [6, "boundary", []],
        [7, "note", []],
      ],
    );
    assert.strictEqual(
      assistantGroupBoundaryLabel(message(6, { text: "compact" })),
      "Context compacted",
    );
    assert.strictEqual(
      assistantGroupBoundaryLabel(message(7, { text: "new" })),
      "New conversation started",
    );
    // A boundary and a change line are never unread.
    assert.isNull(assistantGroupNewSeq(state, 5));
  });

  it.each([
    ["paused", "stopped", "Stopped"],
    ["paused", "routing_failed", "The lead could not route this"],
    ["paused", "handoff_limit", /since your last action/],
    ["paused", "no_delivery", /without a delivery/],
    ["paused", "brand_new", "Paused"],
    ["paused", null, "Paused"],
    ["failed", "outside_project", "Owner cannot work in this request's project"],
    ["failed", "thread_unavailable", "Could not open the owner's conversation"],
    ["failed", "failed", null],
    ["failed", null, null],
    ["running", "stopped", null],
    ["cancelled", "outside_project", "Owner no longer works in this request's project"],
    ["cancelled", "a teammate's own words", null],
  ] as const)("labels a %s task's reason %s", (status, reason, expected) => {
    const label = assistantGroupTaskReasonLabel({ status, reason });
    if (expected instanceof RegExp) assert.match(label ?? "", expected);
    else assert.strictEqual(label, expected);
  });

  it.each([
    ["waiting", "threads:t-1", ["t-1"]],
    ["waiting", "threads:t-1,t-2", ["t-1", "t-2"]],
    ["waiting", "threads: t-1 ,, t-2 ,", ["t-1", "t-2"]],
    ["waiting", "threads:t-1,t-1", ["t-1"]],
    ["waiting", "threads:", null],
    ["waiting", "threads: , ", null],
    ["waiting", "threads:a,b;subagents:x", ["a", "b"]],
    ["waiting", "subagents:x;threads:a", ["a"]],
    ["waiting", "threads:;subagents:x", null],
    ["waiting", "threads:a;", ["a"]],
    ["waiting", "subagents:x", null],
    ["waiting", "waiting for folder:/w/app (used by Bo)", null],
    ["waiting", null, null],
    ["queued", "threads:t-1", null],
    ["running", "threads:t-1", null],
  ] as const)(
    "reads a %s task's reason %j as the threads it waits on",
    (status, reason, expected) => {
      const ids: ReadonlyArray<string> | null = assistantGroupWaitingThreadIds({ status, reason });
      assert.deepStrictEqual(ids, expected);
    },
  );

  it("labels the threads a task waits on", () => {
    assert.strictEqual(assistantGroupWaitingThreadsLabel(1), "Waiting on 1 thread");
    assert.strictEqual(assistantGroupWaitingThreadsLabel(2), "Waiting on 2 threads");
  });
});

const ada = { id: "ada" as AssistantId, name: "Ada", handle: "ada" };
const beto = { id: "beto" as AssistantId, name: "Beto Silva", handle: "beto" };
const jarvis = { id: "jarvis" as AssistantId, name: "Jarvis", handle: "jarvis" };

it.each([
  [{ author: "user", assistantId: null, authorLabel: null }, "you"],
  [{ author: "assistant", assistantId: "ada", authorLabel: null }, "Ada"],
  [{ author: "assistant", assistantId: "gone", authorLabel: null }, "a member"],
  [{ author: "agent", assistantId: null, authorLabel: "Planner" }, "Planner"],
  [{ author: "routine", assistantId: null, authorLabel: null }, "a schedule"],
] as const)("assistantGroupAuthorName(%j)", (message, expected) => {
  assert.strictEqual(
    assistantGroupAuthorName(message as never, (id) => (id === "ada" ? "Ada" : undefined)),
    expected,
  );
});

it.each([
  ["completed", "completed", "Finished"],
  ["failed", "failed", "Failed"],
  ["cancelled", "cancelled", "Cancelled"],
  ["paused", "interrupted", "Paused"],
  ["queued", null, "Queued"],
  ["running", null, "Running"],
  ["waiting", null, "Waiting"],
  ["done", "completed", "Finished"],
  ["needs-you", "interrupted", "Needs you"],
  ["working", null, "Working"],
  ["routing", null, "Routing"],
  ["needs-project", null, "Needs project"],
] as const)("assistantGroupActivity(%s)", (status, expected, label) => {
  assert.deepStrictEqual(assistantGroupActivity(status), { title: "", status: expected, label });
});

it.each([
  [{}, "Worked"],
  [{ workedMs: 42_000 }, "Worked for 42s"],
  [{ workedMs: 125_000 }, "Worked for 2m 5s"],
])("assistantGroupWorkedLabel(%o)", (message, label) => {
  assert.strictEqual(assistantGroupWorkedLabel(message), label);
});

it.each([
  [
    {
      threadTitle: " Weekly report ",
      instruction: "Request from Jarvis (an agent, not the user):\nx",
    },
    "Weekly report",
  ],
  [
    {
      threadTitle: "  ",
      instruction: "Request from Jarvis (an agent, not the user):\nProjeto: t3code. Análise",
    },
    "Projeto: t3code. Análise",
  ],
  [
    {
      threadTitle: null,
      instruction: "Scheduled request Monday report:\n- Summarize **the** week",
    },
    "Summarize the week",
  ],
  [{ instruction: "Plain ask" }, "Plain ask"],
] as const)("assistantGroupActivity title %j", (source, title) => {
  assert.strictEqual(assistantGroupActivity("completed", source).title, title);
});

it.each([
  [
    { thread: { worktreePath: "/wt/feature", projectRoot: "/other" }, requestRoot: "/repo" },
    "/wt/feature",
  ],
  [{ thread: { worktreePath: null, projectRoot: "/repo" }, requestRoot: "/repo" }, "/repo"],
  // A member thread in another project resolves against its own project, not the request's.
  [{ thread: { worktreePath: null, projectRoot: "/other" }, requestRoot: "/repo" }, "/other"],
  [
    { thread: { worktreePath: "/wt/feature", projectRoot: null }, requestRoot: null },
    "/wt/feature",
  ],
  // Its project is not loaded: no root beats a guess that resolves links in the wrong tree.
  [{ thread: { worktreePath: null, projectRoot: null }, requestRoot: "/repo" }, null],
  // No thread (or its shell not loaded yet): only then the request's project.
  [{ thread: null, requestRoot: "/repo" }, "/repo"],
  [{ thread: null, requestRoot: undefined }, null],
] as const)("assistantGroupAnswerRoot(%j)", (input, root) => {
  assert.strictEqual(assistantGroupAnswerRoot(input), root);
});

describe("assistantGroupAwaitingRoute", () => {
  it("is true only for a request with no task and no notice", () => {
    const state = start(
      snapshot(
        [
          message(1),
          message(2),
          message(3),
          message(4, { kind: "notice", author: "assistant", replyToMessageId: "m3" as never }),
          message(5, { author: "assistant", assistantId: "ada" as AssistantId }),
          message(6, { kind: "routing", author: "assistant" }),
          message(7),
          message(8, { kind: "change", author: "assistant", replyToMessageId: "m7" as never }),
          message(9),
          message(10, { kind: "routing", author: "assistant", replyToMessageId: "m9" as never }),
        ],
        [task("k", 2)],
      ),
    );
    assert.deepEqual(
      [...state.messages.values()].map((row) => assistantGroupAwaitingRoute(state, row)),
      [true, false, false, false, false, false, false, false, false, false],
    );
  });
});

describe("composer helpers", () => {
  const ALPHA = { id: "p1" as ProjectId, name: "Alpha" };
  const BETA = { id: "p2" as ProjectId, name: "Beta" };
  const none = { replyOwner: null, request: null, stopped: [] };
  const started = (ownerId: string | null) => ({
    ...none,
    request: { projectId: ALPHA.id, started: true, ownerId: ownerId as AssistantId | null },
  });
  // `AssistantGroups.post` matches a request's tasks by `request_id` alone, so a task from before
  // requests had ids (`requestId` unset) neither starts nor stops its request; with no request,
  // every stopped root of the group counts.
  const chat = start(
    snapshot(
      [
        message(1, { requestId: "m1" as AssistantGroupMessageId, projectId: "p1" as ProjectId }),
        message(2, {
          author: "assistant",
          assistantId: "beto" as AssistantId,
          taskId: "k" as AssistantGroupTask["id"],
          requestId: "m1" as AssistantGroupMessageId,
        }),
        message(3, { requestId: "m3" as AssistantGroupMessageId }),
        message(4, { requestId: "m4" as AssistantGroupMessageId }),
        message(5, {
          author: "assistant",
          assistantId: "ada" as AssistantId,
          taskId: "old" as AssistantGroupTask["id"],
          requestId: "m4" as AssistantGroupMessageId,
        }),
      ],
      [
        task("k", 1, {
          requestId: "m1" as AssistantGroupMessageId,
          ownerId: "beto" as AssistantId,
          status: "failed",
          updatedAt: "2026-11-01T00:00:09.000Z",
        }),
        task("old", 4, { status: "paused", updatedAt: "2026-11-01T00:00:05.000Z" }),
      ],
    ),
  );
  type Row = {
    readonly text: string;
    readonly lead?: typeof jarvis | null;
    readonly routes?: boolean;
    readonly projects?: ReadonlyArray<typeof ALPHA>;
    readonly picked?: ProjectId;
    readonly context?: Parameters<typeof assistantGroupRecipientsPreview>[0]["context"];
    readonly members?: ReadonlyArray<typeof ada>;
  };
  it.each<[string, Row, string | null]>([
    ["an empty draft", { text: " " }, null],
    ["the lead routes", { text: "hello" }, "Jarvis (lead) will route it"],
    // mention_required: "Jarvis is the lead, but its model's provider can't route messages. …"
    [
      "the lead can't route",
      { text: "hello", routes: false },
      "Jarvis (lead) can't route: mention someone with @",
    ],
    ["no lead: it waits", { text: "hello", lead: null }, "Waits for a lead"],
    ["a mention", { text: "@ada do it", routes: false }, "To Ada"],
    ["two mentions", { text: "@ada @betosilva do it" }, "To Ada and Beto Silva"],
    ["everyone", { text: "@everyone go", routes: false }, "To everyone"],
    ["a mention of nobody", { text: "@nobody go", lead: null }, "Waits for a lead"],
    ["a group of one", { text: "hi", lead: null, members: [ada] }, "To Ada"],
    // With several projects and none picked, the lead picks one, even for a mention.
    [
      "no project: the lead picks it",
      { text: "@ada do it", projects: [ALPHA, BETA] },
      "Jarvis (lead) will pick the project",
    ],
    // "Pick the project for this request. Jarvis is the lead, but its model's provider can't …"
    [
      "no project, and the lead can't route",
      { text: "@ada do it", projects: [ALPHA, BETA], routes: false },
      "Pick a project first: Jarvis (lead) can't choose one",
    ],
    [
      "no project, and the lead can't route an unaddressed draft either",
      { text: "hello", projects: [ALPHA, BETA], routes: false },
      "Pick a project first: Jarvis (lead) can't choose one",
    ],
    // "Pick the project for this request: the group has no lead that can choose it."
    [
      "no project, and no lead",
      { text: "@ada do it", projects: [ALPHA, BETA], lead: null },
      "Pick a project first: the group has no lead to choose one",
    ],
    [
      "a picked project",
      { text: "@ada do it", projects: [ALPHA, BETA], picked: BETA.id, routes: false },
      "To Ada",
    ],
    [
      "a #project in the text",
      { text: "@ada fix #beta", projects: [ALPHA, BETA], routes: false },
      "To Ada",
    ],
    [
      "a reply to a member",
      { text: "why?", routes: false, context: { ...started("beto"), replyOwner: { id: beto.id } } },
      "To Beto Silva",
    ],
    // The answered message is older than the loaded history: the quote names the member.
    [
      "a reply to a member whose message is not loaded",
      {
        text: "why?",
        routes: false,
        context: assistantGroupSendContext(chat, {
          id: "m9" as AssistantGroupMessageId,
          to: "Beto Silva",
          projectId: ALPHA.id,
        }),
      },
      "To Beto Silva",
    ],
    [
      "a mention wins over the reply",
      { text: "@ada why?", context: { ...started("beto"), replyOwner: { id: beto.id } } },
      "To Ada",
    ],
    [
      "a reply to a request one member works",
      { text: "more please", routes: false, context: started("ada") },
      "To Ada",
    ],
    [
      "a reply to a request the lead has not routed",
      {
        text: "use alpha",
        projects: [ALPHA, BETA],
        context: { ...none, request: { projectId: null, started: false, ownerId: null } },
      },
      "Jarvis (lead) will pick the project",
    ],
    // A mention does not help: an answer in a request not started goes through the lead.
    [
      "a reply to a request not started, and the lead can't route",
      {
        text: "@ada go",
        routes: false,
        context: { ...none, request: { projectId: ALPHA.id, started: false, ownerId: null } },
      },
      "Jarvis (lead) can't route this request: switch its model",
    ],
    [
      "continue resumes the stopped work",
      {
        text: "continue",
        routes: false,
        context: { ...none, stopped: [{ taskId: "k", ownerId: ada.id }] },
      },
      "Resumes Ada's work",
    ],
    [
      "continue with no stopped work of a member",
      { text: "continue", context: { ...none, stopped: [{ taskId: "k", ownerId: "gone" }] } },
      "Jarvis (lead) will route it",
    ],
  ])("previews %s", (_name, row, expected) => {
    assert.strictEqual(
      assistantGroupRecipientsPreview({
        text: row.text,
        members: row.members ?? [ada, beto, jarvis],
        lead: row.lead === undefined ? jarvis : row.lead,
        leadCanRoute: row.routes,
        projects: row.projects ?? [ALPHA],
        projectId: row.picked ?? null,
        context: row.context ?? none,
      }),
      expected,
    );
  });

  it.each<[string, string | null, unknown]>([
    [
      "a member's answer older than the loaded history",
      "m9",
      {
        replyOwner: { name: "Beto Silva" },
        request: { projectId: "p1", started: true, ownerId: null },
        stopped: [],
      },
    ],
    [
      "a member's answer in a started request",
      "m2",
      {
        replyOwner: { id: "beto" },
        request: { projectId: "p1", started: true, ownerId: "beto" },
        stopped: [{ taskId: "k", ownerId: "beto" }],
      },
    ],
    [
      "a request the lead has not routed",
      "m3",
      {
        replyOwner: null,
        request: { projectId: null, started: false, ownerId: null },
        stopped: [],
      },
    ],
    [
      "an answer whose task has no request id",
      "m5",
      {
        replyOwner: { id: "ada" },
        request: { projectId: null, started: false, ownerId: null },
        stopped: [],
      },
    ],
    [
      "no reply: the group's stopped work, newest first",
      null,
      {
        replyOwner: null,
        request: null,
        stopped: [
          { taskId: "k", ownerId: "beto" },
          { taskId: "old", ownerId: "ada" },
        ],
      },
    ],
  ])("reads the send context of %s", (_name, replyTo, expected) => {
    assert.deepEqual<unknown>(
      assistantGroupSendContext(
        chat,
        replyTo === null
          ? null
          : { id: replyTo as AssistantGroupMessageId, to: "Beto Silva", projectId: ALPHA.id },
      ),
      expected,
    );
  });

  it("keeps the send context equal through events that do not change it", () => {
    const reply = { id: "m2" as AssistantGroupMessageId, to: "Beto Silva", projectId: ALPHA.id };
    const before = assistantGroupSendContext(chat, reply);
    const other = applyAssistantGroupsEvent(chat, { type: "message", message: message(6) })!;
    assert.isTrue(assistantGroupSendContextEqual(before, assistantGroupSendContext(other, reply)));
    const resumed = applyAssistantGroupsEvent(chat, {
      type: "task",
      task: { ...chat.tasks.get("k" as AssistantGroupTask["id"])!, status: "running" },
    })!;
    assert.isFalse(
      assistantGroupSendContextEqual(before, assistantGroupSendContext(resumed, reply)),
    );
  });

  const provider = (instanceId: string, routes: boolean | undefined) =>
    ({
      instanceId,
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      models: [{ slug: `${instanceId}-model`, isDefault: true, isCustom: false }],
      ...(routes === undefined ? {} : { supportsAssistantGroupRouting: routes }),
    }) as unknown as ServerProvider;
  const settingsWith = (projectModel: string | null): ServerSettings =>
    ({
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: null,
      projectSettingsOverrides:
        projectModel === null
          ? {}
          : { home: { defaultModelSelection: { instanceId: projectModel, model: "m" } } },
    }) as unknown as ServerSettings;
  const pick = (instanceId: string) => ({ instanceId, model: "m" }) as ModelSelection;
  it.each([
    ["its conversation's model routes", "t1", pick("claude"), "replay", true],
    ["its conversation's model cannot", "t1", pick("replay"), "claude", false],
    ["its conversation is not loaded", "t1", undefined, "claude", undefined],
    ["no conversation: its home project's model", null, undefined, "replay", false],
    ["no conversation, no project model: the first usable provider", null, undefined, null, false],
    ["an instance the server does not list", "t1", pick("gone"), null, false],
    ["an older server that does not say", "t1", pick("old"), null, undefined],
  ] as const)("the lead can route: %s", (_name, threadId, threadModel, projectModel, expected) => {
    assert.strictEqual(
      assistantGroupLeadCanRoute({
        lead: { threadId: threadId as ThreadId | null, projectId: "home" as ProjectId },
        threadModel,
        settings: settingsWith(projectModel),
        providers: [
          provider("replay", false),
          provider("claude", true),
          provider("old", undefined),
        ],
        project: null,
      }),
      expected,
    );
  });

  it.each([
    ["@", 1, "", 0],
    ["@Ad", 3, "ad", 0],
    ["@ada @be", 8, "be", 5],
    ["  @ada, @b", 10, "b", 8],
    ["thanks @ad", 10, "ad", 7],
    ["(@ad", 4, "ad", 1],
    ["@Beto Si", 8, "beto si", 0],
    ["@Álv", 4, "alv", 0],
  ] as const)("opens the picker for %j", (text, caret, query, start) => {
    assert.deepStrictEqual(assistantGroupMentionQuery(text, caret), {
      start,
      end: caret,
      query,
    });
  });

  it.each([
    ["mail@ada", 8],
    ["@ada ", 5],
    ["hello", 5],
    ["@a b c d", 8],
  ] as const)("does not open the picker for %j", (text, caret) => {
    assert.isNull(assistantGroupMentionQuery(text, caret));
  });

  it.each([
    ["#", 1, "", 0],
    ["fix #Bill", 9, "bill", 4],
    ["(#agenda-ins", 12, "agenda-ins", 1],
    ["#café", 5, "cafe", 0],
  ] as const)("opens the project picker for %j", (text, caret, query, start) => {
    assert.deepStrictEqual(assistantGroupProjectQuery(text, caret), { start, end: caret, query });
  });

  it.each([
    ["issue#4", 7],
    ["#core ", 6],
    ["# heading", 9],
  ] as const)("does not open the project picker for %j", (text, caret) => {
    assert.isNull(assistantGroupProjectQuery(text, caret));
  });

  it("links #projects next to @members, never inside code", () => {
    const projects = [{ id: "p1", name: "Billing API" }];
    assert.strictEqual(
      assistantGroupMarkdownMentions(
        "- @ada fix #billing-api\n- `#billing-api` #nope",
        [ada],
        projects,
      ),
      "- [@ada](t3-mention:mention/ada) fix [#billing-api](t3-mention:project/billing-api)\n- `#billing-api` #nope",
    );
  });

  it.each([
    ["t3-mention:mention/ada", { kind: "member", value: "ada" }],
    ["t3-mention:mention/everyone", { kind: "member", value: "everyone" }],
    ["t3-mention:project/billing-api", { kind: "project", value: "billing-api" }],
    ["t3-mention:mention", null],
    ["https://x.dev/ada", null],
  ] as const)("reads the mention link %j", (href, expected) => {
    assert.deepStrictEqual(assistantGroupMentionHref(href), expected);
  });

  it("chips the members and projects the server reads, by handle or name, ignoring accents", () => {
    const zoe = { id: "zoe" as AssistantId, name: "Zoé Martins", handle: "zoe" };
    const cafe = { id: "p1", name: "Café App" };
    const targets = assistantGroupMentionTargets([ada, zoe], [cafe]);
    const tokens = collectComposerInlineTokens("@Zoé, run #café-app with @everyone", targets);
    assert.deepStrictEqual(
      tokens.map((token) => [token.type, token.value]),
      [
        ["member", "zoe"],
        ["project", "cafe-app"],
        ["member", "everyone"],
      ],
    );
    const target = (kind: "member" | "project", value: string) =>
      assistantGroupMentionTarget(kind, value, [ada, zoe], [cafe]);
    for (const value of ["zoe", "Zoé", "Zoé Martins", "zoemartins"])
      assert.deepStrictEqual(target("member", value), { kind: "member", member: zoe });
    assert.deepStrictEqual(target("member", "everyone"), { kind: "member", member: null });
    assert.deepStrictEqual(target("project", "Café-App"), { kind: "project", project: cafe });
    for (const [kind, value] of [
      ["member", "zoe-x"],
      ["member", "zo"],
      ["project", "cafe"],
    ] as const)
      assert.isNull(target(kind, value));
  });

  it("tells projects whose titles make the same slug apart, everywhere a client names them", () => {
    const second = { id: "p2", name: "Core" };
    const first = { id: "p1", name: "core" };
    const projects = [second, first];
    assert.deepStrictEqual(assistantGroupMentionTargets([], projects).projectSlugs, [
      "core-2",
      "core",
    ]);
    const [token] = collectComposerInlineTokens(
      "run #core-2",
      assistantGroupMentionTargets([], projects),
    );
    assert.deepStrictEqual(assistantGroupMentionTarget("project", token!.value, [], projects), {
      kind: "project",
      project: second,
    });
    assert.strictEqual(
      assistantGroupMarkdownMentions("#core-2 #core", [], projects),
      "[#core-2](t3-mention:project/core-2) [#core](t3-mention:project/core)",
    );
    const query = assistantGroupProjectQuery("#core", 5)!;
    const [option] = assistantGroupProjectOptions("core-", projects);
    assert.deepStrictEqual(insertAssistantGroupProject("#core", query, option!), {
      text: "#core-2 ",
      caret: 8,
    });
  });

  it("offers matching projects and inserts the picked one as its #slug", () => {
    const projects = [
      { id: "p1", name: "Billing API" },
      { id: "p2", name: "agenda-instagram" },
    ];
    assert.deepStrictEqual(assistantGroupProjectOptions("billing-a", projects), [
      { ...projects[0]!, slug: "billing-api" },
    ]);
    assert.deepStrictEqual(
      assistantGroupProjectOptions("", projects).map((project) => project.id),
      ["p1", "p2"],
    );
    const query = assistantGroupProjectQuery("run in #bil now", 11)!;
    assert.deepStrictEqual(
      insertAssistantGroupProject(
        "run in #bil now",
        query,
        assistantGroupProjectOptions(query.query, projects)[0]!,
      ),
      {
        text: "run in #billing-api now",
        caret: 20,
      },
    );
  });

  it("links member mentions in markdown, but not in code or author bold", () => {
    const m = (t: string) => `[${t}](${ASSISTANT_MENTION_HREF}/${t.slice(1).toLowerCase()})`;
    const md = "Oi @Ada, `@ada` e @ghost\n```\n@ada\n```\n- @beto ok\n````\n```\n@ada\n````\n@ada";
    assert.strictEqual(
      assistantGroupMarkdownMentions(md, [ada, beto]),
      `Oi ${m("@Ada")}, \`@ada\` e @ghost\n\`\`\`\n@ada\n\`\`\`\n- ${m("@beto")} ok\n\`\`\`\`\n\`\`\`\n@ada\n\`\`\`\`\n${m("@ada")}`,
    );
    assert.strictEqual(
      assistantGroupMarkdownMentions("Oi @Beto Silva e @everyone", [ada, beto]),
      "Oi [@Beto Silva](t3-mention:mention/beto) e [@everyone](t3-mention:mention/everyone)",
    );
    assert.strictEqual(assistantGroupMarkdownMentions("**bold** text", [ada]), "**bold** text");
    assert.strictEqual(assistantGroupMarkdownMentions("no mention", [ada]), "no mention");
    // Links and autolinks stay intact; a mention inside one would nest links.
    for (const kept of [
      "[ask @ada](https://x.dev)",
      "<https://x.dev/@ada>",
      "see https://x.dev/@ada now",
    ]) {
      assert.strictEqual(assistantGroupMarkdownMentions(kept, [ada]), kept);
    }
    assert.strictEqual(
      assistantGroupMarkdownMentions("[docs](https://x.dev) for @ada", [ada]),
      `[docs](https://x.dev) for ${m("@ada")}`,
    );
  });

  it("offers matching members and everyone, and inserts the handle with a space", () => {
    const members = [ada, beto, jarvis];
    assert.deepStrictEqual(
      assistantGroupMentionOptions("", members).map((option) =>
        option.kind === "everyone" ? "everyone" : option.member.handle,
      ),
      ["ada", "beto", "jarvis", "everyone"],
    );
    assert.strictEqual(assistantGroupMentionOptions("beto", members).length, 1);
    assert.strictEqual(assistantGroupMentionOptions("betos", members).length, 1);
    assert.strictEqual(assistantGroupMentionOptions("every", members).length, 1);
    assert.strictEqual(assistantGroupMentionOptions("zz", members).length, 0);
    const query = assistantGroupMentionQuery("@Ad do it", 3)!;
    assert.deepStrictEqual(
      insertAssistantGroupMention("@Ad do it", query, { kind: "member", member: ada }),
      { text: "@ada do it", caret: 5 },
    );
    assert.deepStrictEqual(
      insertAssistantGroupMention("@", assistantGroupMentionQuery("@", 1)!, { kind: "everyone" }),
      { text: "@everyone ", caret: 10 },
    );
  });
});

describe("read position", () => {
  const first = { requestId: "m1" as never };
  const second = { requestId: "m4" as never };
  const lines = [
    message(1, first),
    message(2, { ...first, author: "assistant", kind: "routing" }),
    message(3, { ...first, author: "assistant" }),
    message(4, second),
    message(5, { ...second, author: "agent", kind: "notice" }),
  ];
  const chat = start(snapshot(lines, []));
  it("puts the New line before the first message others wrote past the read position", () => {
    assert.strictEqual(assistantGroupLatestSeq(chat), 5);
    assert.strictEqual(assistantGroupNewSeq(chat, 0), 3);
    assert.strictEqual(assistantGroupNewSeq(chat, 3), 5);
    assert.strictEqual(assistantGroupNewSeq(chat, 5), null);
    assert.strictEqual(assistantGroupLatestSeq({ ...chat, messages: new Map() }), 0);
    // A line the user answered later in its request, or of no request, is not new.
    const answered = start(snapshot([...lines, message(6, second)], []));
    assert.strictEqual(assistantGroupNewSeq(answered, 3), null);
    const loose = start(snapshot([message(7, { author: "agent", kind: "notice" })], []));
    assert.strictEqual(assistantGroupNewSeq(loose, 0), null);
  });

  it("All's New line skips what a tab already read", () => {
    const project = "p1" as ProjectId;
    const state = start(
      snapshot(
        [
          message(1, { requestId: "m1" as never, projectId: project }),
          message(2, { author: "assistant", requestId: "m1" as never }),
          message(3, { requestId: "m3" as never }),
          message(4, { author: "assistant", requestId: "m3" as never }),
          message(5, { author: "agent", kind: "notice", requestId: "m3" as never }),
        ],
        [],
      ),
    );
    const scopes = [{ projectId: project, unreadCount: 0, waiting: false, readSeq: 2 }];
    assert.strictEqual(assistantGroupNewSeq(state, 0), 2);
    assert.strictEqual(
      assistantGroupNewSeq(state, assistantGroupAllReadSeq(state, { readSeq: 0, scopes })),
      4,
    );
    assert.strictEqual(
      assistantGroupNewSeq(state, assistantGroupAllReadSeq(state, { readSeq: 4, scopes })),
      5,
    );
  });

  it.each([
    { name: "unread when opened", latestSeq: 4, readSeq: 1, seen: 0, seenAfter: 1, target: 4 },
    { name: "read when opened", latestSeq: 4, readSeq: 4, seen: 0, seenAfter: 4, target: null },
    {
      name: "read when opened, then marked unread",
      latestSeq: 4,
      readSeq: 1,
      seen: 4,
      seenAfter: 4,
      target: null,
    },
    {
      name: "marked unread, then a newer one",
      latestSeq: 5,
      readSeq: 1,
      seen: 4,
      seenAfter: 4,
      target: 5,
    },
    { name: "not loaded", latestSeq: null, readSeq: 0, seen: 0, seenAfter: 0, target: null },
  ])("reports an open chat as read: $name", ({ latestSeq, readSeq, seen, seenAfter, target }) => {
    assert.deepStrictEqual(assistantGroupReadStep({ latestSeq, readSeq, seen }), {
      seen: seenAfter,
      target,
    });
  });

  it("announces an older server's group once, when its work goes from open to none", () => {
    const chatOf = (working: boolean, preview: string | null) => ({
      latestSeq: 3,
      readSeq: 0,
      unreadCount: 1,
      working,
      preview,
    });
    const busy = { name: "Ops", chat: chatOf(true, null) };
    const idle = { name: "Ops", chat: chatOf(false, "All   done.\nShip it.") };
    assert.deepStrictEqual(assistantGroupFinished(busy, idle, []), [
      { title: "Ops finished", body: "All done. Ship it.", projectId: null, tab: "all" },
    ]);
    assert.deepStrictEqual(assistantGroupFinished(idle, idle, []), []);
    assert.deepStrictEqual(assistantGroupFinished(undefined, idle, []), []);
    assert.deepStrictEqual(assistantGroupFinished(busy, busy, []), []);
    assert.deepStrictEqual(assistantGroupFinished(busy, { name: "Ops" }, []), []);
    assert.deepStrictEqual(
      assistantGroupFinished(busy, { ...idle, archivedAt: "2026-11-09T00:00:00.000Z" }, []),
      [],
    );
    assert.strictEqual(
      assistantGroupFinished(busy, { name: "Ops", chat: chatOf(false, "x".repeat(300)) }, [])[0]
        ?.body.length,
      140,
    );
    // The request's project leads the body; General and an unknown project add nothing.
    const web = [{ id: "p-web" as ProjectId, title: "web" }];
    const scoped = (previewProjectId: ProjectId | null) => ({
      ...idle,
      chat: { ...idle.chat, previewProjectId },
    });
    assert.deepStrictEqual(assistantGroupFinished(busy, scoped("p-web" as ProjectId), web), [
      {
        title: "Ops finished",
        body: "[web] All done. Ship it.",
        projectId: "p-web" as ProjectId,
        tab: "project:p-web",
      },
    ]);
    assert.strictEqual(
      assistantGroupFinished(busy, scoped(null), web)[0]?.body,
      "All done. Ship it.",
    );
    assert.strictEqual(
      assistantGroupFinished(busy, scoped("p-gone" as ProjectId), web)[0]?.body,
      "All done. Ship it.",
    );
  });

  const tabbed = (
    open: ReadonlyArray<readonly [string | null, number]>,
    previewProjectId: string | null = "p1",
  ) => ({
    name: "Ops",
    chat: {
      latestSeq: 3,
      readSeq: 0,
      unreadCount: 0,
      working: open.length > 0,
      preview: "Fixed it.",
      previewProjectId: previewProjectId as ProjectId | null,
      scopes: open.map(([projectId, openTasks]) => ({
        projectId: projectId as ProjectId | null,
        unreadCount: 0,
        waiting: false,
        readSeq: 0,
        openTasks,
      })),
    },
  });
  it.each([
    [
      "a project ends while another runs",
      tabbed([
        ["p1", 1],
        ["p2", 1],
      ]),
      tabbed([["p2", 1]]),
      [["project:p1", "[one] Fixed it."]],
    ],
    [
      "two projects end together",
      tabbed([
        ["p1", 1],
        ["p2", 2],
      ]),
      tabbed([]),
      [
        ["project:p1", "[one] Fixed it."],
        ["project:p2", "Work finished"],
      ],
    ],
    [
      "the latest line is General's, after the work",
      tabbed([["p1", 1]]),
      tabbed([], null),
      [["project:p1", "[one] Work finished"]],
    ],
    ["General ends", tabbed([[null, 1]], null), tabbed([], null), [["general", "Fixed it."]]],
    ["a request that gets a project moves its work", tabbed([[null, 1]]), tabbed([["p1", 1]]), []],
  ] as const)("announces per tab: %s", (_name, previous, next, expected) => {
    const projects = [{ id: "p1" as ProjectId, title: "one" }];
    assert.deepStrictEqual(
      assistantGroupFinished(previous, next, projects).map((notice) => [notice.tab, notice.body]),
      expected as unknown as string[][],
    );
  });
});

describe("assistantGroupFinishedInView", () => {
  it.each([
    ["no tab row", null, "project:p1", true],
    ["All", "all", "project:p1", true],
    ["All, for General", "all", "general", true],
    ["its project's tab", "project:p1", "project:p1", true],
    ["another project's tab", "project:p2", "project:p1", false],
    ["a project's tab, for General", "project:p1", "general", false],
    ["General, for General", "general", "general", true],
    ["General, for a project", "general", "project:p1", false],
    ["a project's tab, for an older server's All", "project:p1", "all", false],
  ] as const)("%s", (_name, open, finished, expected) => {
    assert.strictEqual(assistantGroupFinishedInView(open, finished), expected);
  });
});

describe("assistantGroupMessageExcerpt", () => {
  it.each([
    [
      "Found it:\n- `AuthStore.load()` skips\n- **the** build",
      "Found it: AuthStore.load() skips the build",
    ],
    ["## Plan\n1. see [docs](https://x.y)\n```ts\nconst a = 1\n```", "Plan see docs const a = 1"],
    ["> quoted\nplain  text", "quoted plain text"],
  ])("%j", (input, expected) => {
    assert.strictEqual(assistantGroupMessageExcerpt(input), expected);
  });
});

describe("assistant group tabs", () => {
  const P1 = "p1" as ProjectId;
  const P2 = "p2" as ProjectId;
  const P3 = "p3" as ProjectId;
  const ONE = [{ id: P1, title: "One" }];
  const projects = [
    { id: P1, title: "One" },
    { id: P2, title: "Two" },
    { id: P3, title: "Three" },
  ];
  const member = (projectId: ProjectId) => ({ projectId, projectIds: [] });
  const scope = (
    projectId: ProjectId | null,
    unreadCount = 0,
    waiting = false,
  ): AssistantTeamChatScope => ({ projectId, unreadCount, waiting, readSeq: 3 });
  const tabs = (
    members: ProjectId[],
    scopes: ReturnType<typeof scope>[] | undefined,
    teamProjects: ProjectId[] = [],
  ) =>
    assistantGroupTabs({
      team: {
        projectIds: teamProjects,
        chat: { unreadCount: 5, readSeq: 1, ...(scopes ? { scopes } : {}) },
      } as never,
      members: members.map(member),
      projects,
    });
  const keys = (result: ReturnType<typeof tabs>) => result?.map((tab) => tab.key) ?? null;

  type Row = [
    string,
    ProjectId[],
    ReturnType<typeof scope>[] | undefined,
    string[] | null,
    ProjectId[]?,
  ];
  const rows: Row[] = [
    ["no projects", [], [scope(null)], null],
    ["one project", [P1], [scope(P1)], null],
    ["scopes absent", [P1, P2], undefined, null],
    ["two projects", [P1, P2], [scope(P1), scope(P2)], ["all", "project:p1", "project:p2"]],
    [
      "General only when listed",
      [P1, P2],
      [scope(P1), scope(P2), scope(null)],
      ["all", "project:p1", "project:p2", "general"],
    ],
    [
      "General listed only for its work's end has no tab",
      [P1, P2],
      [scope(P1), scope(P2), { ...scope(null), doneTasks: 1, hasRequests: false }],
      ["all", "project:p1", "project:p2"],
    ],
    [
      "orphan with unread sits before General",
      [P1, P2],
      [scope(null), scope(P3, 1), scope(P1)],
      ["all", "project:p1", "project:p2", "project:p3", "general"],
    ],
    [
      "orphan without unread has no tab",
      [P1, P2],
      [scope(P3), scope(P1)],
      ["all", "project:p1", "project:p2"],
    ],
    [
      "unknown orphan waiting",
      [P1, P2],
      [scope("gone" as ProjectId, 0, true)],
      ["all", "project:p1", "project:p2", "project:gone"],
    ],
    ["team project ids count", [P1], [scope(P2)], ["all", "project:p2", "project:p1"], [P2]],
  ];
  it.each(rows)("%s", (_name, members, scopes, expected, teamProjects) => {
    assert.deepStrictEqual(keys(tabs(members, scopes, teamProjects)), expected);
  });

  const pending = (
    memberIds: string[],
    loaded: string[],
    members: ProjectId[],
    loadedProjects: typeof projects,
    scopes: ReturnType<typeof scope>[] | null = [scope(P1), scope(P2)],
  ) =>
    assistantGroupTabsPending({
      team: {
        projectIds: [],
        memberIds,
        chat: { unreadCount: 5, readSeq: 1, ...(scopes ? { scopes } : {}) },
      } as never,
      members: members.map(member),
      projects: loadedProjects,
      assistants: new Set(loaded),
    });

  const pendingRows: [string, boolean, boolean][] = [
    ["projects not loaded yet", pending(["a", "b"], ["a", "b"], [P1, P2], []), true],
    ["a member not loaded yet", pending(["a", "b"], ["a"], [P1], projects), true],
    ["loaded, two projects", pending(["a", "b"], ["a", "b"], [P1, P2], projects), false],
    ["loaded, one project gone", pending(["a", "b"], ["a", "b"], [P1, P3], [projects[0]!]), false],
    ["one project, none loaded", pending(["a"], ["a"], [P1], []), false],
    ["older server", pending(["a", "b"], [], [P1, P2], [], null), false],
  ].map(([name, got, want]) => [name as string, got as boolean, want as boolean]);
  it.each(pendingRows)("pending: %s", (_name, got, want) => {
    assert.strictEqual(got, want);
  });

  it("labels, counts and read positions", () => {
    const result = tabs(
      [P1, P2],
      [scope(P1, 2), scope(P2, 0, true), scope("gone" as ProjectId, 1), scope(null)],
    )!;
    assert.deepStrictEqual(
      result.map((tab) => [tab.label, tab.unreadCount, tab.waiting, tab.projectId, tab.readSeq]),
      [
        ["All", 5, true, null, 1],
        ["One", 2, false, P1, 3],
        ["Two", 0, true, P2, 3],
        ["Removed project", 1, false, "gone", 3],
        ["General", 0, false, null, 3],
      ],
    );
    assert.strictEqual(result[0]!.scope, undefined);
    assert.deepStrictEqual(result[4]!.scope, { projectId: null });
    // A tab the server does not list has nothing unread: it reads from the group's position.
    assert.strictEqual(tabs([P1, P2], [scope(P1)])![2]!.readSeq, 1);
    assert.deepStrictEqual(result[1]!.scope, { projectId: P1 });
  });

  const view = (
    members: ProjectId[],
    scopes: ReturnType<typeof scope>[] | undefined,
    saved: string | null,
    loadedProjects = projects,
    loading = false,
  ) =>
    assistantGroupTabView({
      team: {
        projectIds: [],
        memberIds: members.map((_, index) => `m${index}`),
        chat: { unreadCount: 5, readSeq: 1, ...(scopes ? { scopes } : {}) },
      } as never,
      members: members.map(member),
      projects: loadedProjects,
      assistants: { has: () => true },
      saved,
      loading,
    });
  const viewKeys = (result: ReturnType<typeof view>) => ({
    pending: result.pending,
    tabs: result.tabs?.map((tab): string => tab.key) ?? null,
    tab: (result.tab?.key as string | undefined) ?? null,
  });

  it.each([
    [
      "an open orphan with nothing unread",
      view([P1, P2], [scope(P1), scope(P3)], "project:p3"),
      {
        pending: false,
        tabs: ["all", "project:p1", "project:p2", "project:p3"],
        tab: "project:p3",
      },
    ],
    [
      "a group shrunk to one project",
      view([P1], [scope(P1), scope(P2)], "project:p2"),
      { pending: false, tabs: ["all", "project:p1", "project:p2"], tab: "project:p2" },
    ],
    [
      "a scope the server no longer lists",
      view([P1, P2], [scope(P1)], "project:p3"),
      {
        pending: false,
        tabs: ["all", "project:p1", "project:p2", "project:p3"],
        tab: "project:p3",
      },
    ],
    [
      "a stale key neither loaded nor listed",
      view([P1, P2], [scope(P1)], "project:gone"),
      { pending: false, tabs: ["all", "project:p1", "project:p2"], tab: "all" },
    ],
    [
      "General the server does not list",
      view([P1, P2], [scope(P1)], "general"),
      { pending: false, tabs: ["all", "project:p1", "project:p2", "general"], tab: "general" },
    ],
    [
      "an open live tab is not repeated",
      view([P1, P2], [scope(P1), scope(P2)], "project:p2"),
      { pending: false, tabs: ["all", "project:p1", "project:p2"], tab: "project:p2" },
    ],
    [
      "All keeps nothing",
      view([P1], [scope(P1), scope(P2)], "all"),
      { pending: false, tabs: null, tab: null },
    ],
    [
      "no saved tab keeps nothing",
      view([P1], [scope(P1)], null),
      { pending: false, tabs: null, tab: null },
    ],
    [
      "older server",
      view([P1, P2], undefined, "project:p1"),
      { pending: false, tabs: null, tab: null },
    ],
    [
      "projects still loading",
      view([P1, P2], [scope(P1), scope(P2)], "project:p1", []),
      { pending: true, tabs: null, tab: null },
    ],
    [
      "the saved tab still loading",
      view([P1, P2], [scope(P1), scope(P2)], null, projects, true),
      { pending: true, tabs: null, tab: null },
    ],
    [
      "older server while the saved tab loads",
      view([P1, P2], undefined, null, projects, true),
      { pending: false, tabs: null, tab: null },
    ],
  ])("view: %s", (_name, result, expected) => {
    assert.deepStrictEqual(viewKeys(result), expected);
  });

  it.each([
    ["a project tab reads its scope", view([P1, P2], [scope(P1)], "project:p2"), { projectId: P2 }],
    ["All reads every request", view([P1, P2], [scope(P1)], null), undefined],
    ["no tabs read every request", view([P1, P2], undefined, null), undefined],
    ["pending reads nothing", view([P1, P2], [scope(P1)], null, [], true), null],
    [
      "an unknown group reads nothing",
      assistantGroupTabView({
        team: undefined,
        members: [],
        projects,
        assistants: { has: () => true },
        saved: null,
      }),
      null,
    ],
  ])("view scope: %s", (_name, result, expected) => {
    assert.deepStrictEqual(result.scope, expected);
  });

  it("labels a kept tab by the project's live title, else its last known one", () => {
    const titled = { ...scope(P3), title: "Old three" };
    const labels = (scopes: ReturnType<typeof scope>[], saved: string, loaded = projects) =>
      view([P1, P2], scopes, saved, loaded).tabs?.map((tab) => tab.label);
    assert.deepStrictEqual(labels([scope(P1), titled], "project:p3"), [
      "All",
      "One",
      "Two",
      "Three",
    ]);
    assert.deepStrictEqual(labels([scope(P1), titled], "project:p3", projects.slice(0, 2)), [
      "All",
      "One",
      "Two",
      "Old three",
    ]);
    // Two projects the chat never knew a title for still read apart.
    const lost = (id: string) => scope(id as ProjectId, 1);
    assert.deepStrictEqual(
      labels([lost("x"), { ...titled, unreadCount: 1 }, lost("y")], "all", projects.slice(0, 2)),
      ["All", "One", "Two", "Removed project", "Old three", "Removed project 2"],
    );
    // R1 is read so its tab is gone; the server's list still numbers R2 after it, as the feed does.
    const numbered = assistantGroupTabs({
      team: {
        projectIds: [],
        chat: {
          unreadCount: 1,
          readSeq: 1,
          scopes: [lost("r2")],
          removedProjectIds: ["r1", "r2"],
        },
      } as never,
      members: [P1, P2].map(member),
      projects: projects.slice(0, 2),
    });
    assert.deepStrictEqual(
      numbered?.map((tab) => tab.label),
      ["All", "One", "Two", "Removed project 2"],
    );
  });

  it.each([
    ["a group project whose title has not loaded", P3, [P3], [], [P3, P2], "Unknown project"],
    ["the next one loading, in group order", P2, [P3, P2], [], [P3, P2], "Unknown project 2"],
    ["a group project the loaded list no longer has", P3, [P3], ONE, [P3], "Removed project"],
    ["a project that left the group, unnamed", P3, [], ONE, [P3, P2], "Removed project 2"],
    ["the same one, whatever the tab order", P3, [], ONE, [P2, P3], "Removed project 2"],
    ["the first unnamed one by id", P2, [P3], ONE, [P3, P2], "Removed project"],
    ["a saved tab's one the chat does not list", "p9", [], ONE, [P3, P2], "Removed project 3"],
    ["a title known from the chat", P1, [P1], ONE, [P3, P2], "One"],
    ["the server's list, not the tabs", "p9", [], ONE, [], "Removed project 2", ["p8", "p9"]],
    [
      "an older page's one already counts",
      "r1",
      [],
      ONE,
      ["r2"],
      "Removed project 2",
      ["r0", "r1"],
    ],
    [
      "one the server's list lacks comes last",
      "r3",
      [],
      ONE,
      ["r3"],
      "Removed project 3",
      ["r0", "r1"],
    ],
    ["a named one in the list takes no number", "r1", [], ONE, [], "Removed project", [P1, "r1"]],
  ] as const)("project label: %s", (_name, id, group, projects, order, expected, removed?) => {
    const scopes = order.map((projectId) => ({ projectId: projectId as ProjectId }));
    assert.strictEqual(
      assistantGroupProjectLabel(
        id as ProjectId,
        projects,
        scopes,
        group,
        removed?.map((id) => id as ProjectId),
      ),
      expected,
    );
  });

  it.each([
    ["every group project while projects load", [], [P1, P2, P3]],
    ["only the ones the environment still has", ONE, [P1]],
  ] as const)("composer projects: %s", (_name, projects, expected) => {
    assert.deepStrictEqual(assistantGroupComposerProjects([P1, P2, P3], projects), expected);
  });

  it.each([
    ["a pick in the open tab", { tab: "project:p1", value: P2 }, "project:p1", false, P2],
    ["a pick for lead decides", { tab: "project:p1", value: null }, "project:p1", false, null],
    ["a pick from another tab lapses", { tab: "all", value: P2 }, "project:p1", false, P1],
    ["the open tab's project", null, "project:p2", false, P2],
    ["All leaves it to the lead", null, "all", false, null],
    ["a reply keeps its request's", null, "project:p2", true, null],
    ["a pick still counts in a reply", { tab: "all", value: P1 }, "all", true, P1],
    ["a project that left the group", { tab: "all", value: P3 }, "all", false, null],
    ["a removed project's tab", null, "project:p3", false, null],
    ["no tabs", { tab: null, value: P1 }, null, false, P1],
  ] as const)("composer project: %s", (_name, pick, open, replying, expected) => {
    const opened = tabs([P1, P2], [scope(P1), scope(P2), scope(P3, 1)])?.find(
      (tab) => tab.key === open,
    );
    assert.strictEqual(
      assistantGroupComposerProject({
        pick,
        tab: opened ?? null,
        replying,
        groupProjects: [{ id: P1 }, { id: P2 }],
      }),
      expected,
    );
  });

  const pickOf = (model: string, tab: string | null = "project:p1") => ({
    tab: tab as "project:p1" | null,
    value: { instanceId: "claudeAgent", model } as ModelSelection,
  });
  it.each([
    ["no pick shows the default", null, "project:p1", "project", "project"],
    ["a pick in the open tab is this message's", pickOf("opus"), "project:p1", "opus", "message"],
    ["another tab drops the pick", pickOf("opus"), "all", "project", "project"],
    [
      "a pick the project cannot use shows the default",
      pickOf("off"),
      "project:p1",
      "project",
      "project",
    ],
    ["no tabs yet", pickOf("opus", null), null, "opus", "message"],
    // The server drops it too, as `isPickedModelUsable` rules on both sides.
    ["a pick its provider no longer lists", pickOf("gone"), "project:p1", "project", "project"],
  ] as const)("composer model: %s", (_name, pick, tab, model, layer) => {
    const shown = assistantGroupComposerModel({
      pick,
      tab,
      defaults: {
        project: { instanceId: "codex", model: "project" } as ModelSelection,
        global: { instanceId: "codex", model: "global" } as ModelSelection,
      },
      isUsable: (selection) => selection.model !== "off",
      available: {
        settings: { providerInstances: {}, projectSettingsOverrides: {} },
        projectId: P1,
        providers: [
          {
            instanceId: "claudeAgent" as ModelSelection["instanceId"],
            models: [{ slug: "opus" }, { slug: "off" }],
          },
        ],
      },
    });
    assert.deepStrictEqual(
      { model: shown.selection.model, layer: shown.layer, forMessage: shown.forMessage },
      { model, layer, forMessage: layer === "message" },
    );
  });

  it("a tab pick is dropped for good once another tab shows, chosen or not", () => {
    const pick = { tab: "project:p1" as const, value: P2 };
    assert.strictEqual(assistantGroupTabPick(pick, "project:p1"), pick);
    // The client keeps what it returns, so coming back to the tab finds nothing.
    let kept = assistantGroupTabPick(pick, "all");
    assert.isNull(kept);
    kept = assistantGroupTabPick(kept, "project:p1");
    assert.isNull(kept);
  });

  it.each([
    ["older server", undefined, false],
    ["no scopes", { scopes: [] }, false],
    ["none waiting", { scopes: [scope(P1, 2), scope(null)] }, false],
    ["General waits", { scopes: [scope(P1), scope(null, 0, true)] }, true],
    ["a removed project waits", { scopes: [scope("gone" as ProjectId, 0, true)] }, true],
  ] as const)("chat waiting: %s", (_name, chat, expected) => {
    assert.strictEqual(assistantGroupChatWaiting(chat), expected);
  });

  it.each([
    [null, "all"],
    ["project:p2", "project:p2"],
    ["project:gone", "all"],
    ["general", "all"],
  ])("resolves saved %j", (saved, expected) => {
    const result = tabs([P1, P2], [scope(P1), scope(P2)])!;
    assert.strictEqual(resolveAssistantGroupTab(saved, result).key, expected);
  });

  it.each([
    ["All stays", "all", "all", P2, null],
    ["its own project stays", "project:p1", "project:p1", P1, null],
    ["another project follows", "project:p1", "project:p1", P2, "project:p2"],
    ["no project yet goes to All", "project:p1", "project:p1", null, "all"],
    ["General keeps one with none", "general", "general", null, null],
    ["a project without a tab goes to All", "general", "general", P3, "all"],
    ["a stale key is All", "all", "project:gone", P2, null],
    ["leaving its own project for another stays", "project:p1", "project:p2", P1, null],
    ["leaving for General stays off the target", "project:p1", "general", P2, null],
    ["leaving for the target stays", "project:p1", "project:p2", P2, null],
  ] as const)("after a send: %s", (_name, sent, saved, landed, expected) => {
    const result = tabs([P1, P2], [scope(P1), scope(P2), scope(null)])!;
    assert.strictEqual(assistantGroupTabAfterSend(result, sent, saved, landed), expected);
  });

  const out = (tab: AssistantGroupTabKey | null, failed = false, attachmentIds: string[] = []) => ({
    tab,
    failed,
    attachmentIds,
  });
  const refusedP1 = out("project:p1", true, ["f1"]);
  const sendingP1 = out("project:p1");
  const sendingP2 = out("project:p2", false, ["f2"]);
  const fromAll = out("all");
  const noTabs = out(null);
  it.each([
    ["nothing outgoing", [], "project:p1", null],
    ["on its way, in its tab", [sendingP1], "project:p1", sendingP1],
    ["on its way, in All", [sendingP1], "all", sendingP1],
    ["on its way, in another project", [sendingP1], "project:p2", null],
    ["on its way, in General", [sendingP1], "general", null],
    ["sent from All, in a project", [fromAll], "project:p1", null],
    ["sent with no tabs", [noTabs], null, noTabs],
    ["refused, in its tab", [refusedP1], "project:p1", refusedP1],
    ["refused, in All", [refusedP1], "all", null],
    ["refused, in another project", [refusedP1], "project:p2", null],
    [
      "refused, and another tab's send, in the refused tab",
      [refusedP1, sendingP2],
      "project:p1",
      refusedP1,
    ],
    [
      "refused, and another tab's send, in the sending tab",
      [refusedP1, sendingP2],
      "project:p2",
      sendingP2,
    ],
    ["refused, and another tab's send, in All", [refusedP1, sendingP2], "all", sendingP2],
    ["refused, and another tab's send, in a third tab", [refusedP1, sendingP2], "general", null],
    ["All's own and another tab's send, in All", [sendingP2, fromAll], "all", fromAll],
    ["two tabs' sends, in All", [sendingP1, sendingP2], "all", sendingP2],
  ] as const)("composer shows the outgoing message: %s", (_name, outgoing, tab, expected) => {
    assert.strictEqual(assistantGroupShownOutgoing(outgoing, tab), expected);
  });

  it.each([
    ["the open tab's own files", refusedP1, ["f2"]],
    ["in a tab that shows none", null, ["f1", "f2"]],
  ] as const)("holds another message's files back: %s", (_name, shown, held) => {
    assert.deepStrictEqual(
      [...assistantGroupHeldAttachments([refusedP1, sendingP2], shown)],
      [...held],
    );
  });

  const sent = ["hi", ["f1"], "p1", { model: "opus" }, null] as const;
  it.each([
    ["a first send", null, sent, "fresh"],
    ["a failed message sent again unchanged", sent, sent, "first"],
    ["changed text", sent, ["hi!", ["f1"], "p1", { model: "opus" }, null], "fresh"],
    ["another file", sent, ["hi", ["f1", "f2"], "p1", { model: "opus" }, null], "fresh"],
    ["another project", sent, ["hi", ["f1"], "p2", { model: "opus" }, null], "fresh"],
    ["another model", sent, ["hi", ["f1"], "p1", { model: "sonnet" }, null], "fresh"],
    ["a reply now", sent, ["hi", ["f1"], "p1", { model: "opus" }, { to: "ada" }], "fresh"],
  ] as const)("a send's request id: %s", (_name, before, now, expected) => {
    const failed =
      before === null ? null : assistantGroupSendRequestId(null, before, () => "first");
    const next = assistantGroupSendRequestId(failed, now, () => "fresh");
    assert.strictEqual(next.requestId, expected);
  });

  it("keeps each tab's outgoing message until that tab replaces or clears it", () => {
    const store = createAssistantGroupOutgoingStore();
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.set("g1", "project:p1", refusedP1);
    const kept = store.get("g1");
    // Another tab's send and its end leave the refused one as it was.
    store.set("g1", "project:p2", sendingP2);
    store.set("g1", "project:p2", null);
    store.set("g2", "all", fromAll);
    store.set("g2", "all", null);
    stop();
    store.set("g3", null, refusedP1);
    assert.deepStrictEqual(
      [store.get("g1"), store.get("g2"), store.get("g2") === store.get("g2"), calls],
      [[refusedP1], [], true, 5],
    );
    store.set("g1", "project:p1", sendingP1);
    assert.deepStrictEqual([kept, store.get("g1")], [[refusedP1], [sendingP1]]);
    store.clear();
    assert.deepStrictEqual([store.get("g1"), store.get("g3")], [[], []]);
  });

  it.each([
    [undefined, P1, true],
    [undefined, null, true],
    [{ projectId: null }, null, true],
    [{ projectId: null }, P1, false],
    [{ projectId: P1 }, P1, true],
    [{ projectId: P1 }, P2, false],
    [{ projectId: P1 }, null, false],
  ] as const)("in scope %j for request in %j: %s", (tabScope, projectId, expected) => {
    assert.strictEqual(assistantGroupInScope({ projectId }, tabScope && { ...tabScope }), expected);
  });
});
