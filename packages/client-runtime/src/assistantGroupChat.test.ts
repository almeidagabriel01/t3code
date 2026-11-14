import { assert, describe, it } from "@effect/vitest";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import type {
  AssistantGroupMessage,
  AssistantGroupTask,
  AssistantGroupsEvent,
  AssistantId,
  AssistantTeamId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyAssistantGroupHistory,
  applyAssistantGroupsEvent,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupBoundaryLabel,
  assistantGroupFeed,
  assistantGroupFeedProjects,
  assistantGroupFinished,
  assistantGroupRequestExpanded,
  assistantGroupRequestFeed,
  filterAssistantGroupFeed,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
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
  assistantGroupRecipientsPreview,
  assistantGroupRunningCount,
  insertAssistantGroupMention,
  oldestAssistantGroupSeq,
  type AssistantGroupChatState,
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
    assert.deepStrictEqual(assistantGroupFeedProjects(feed), [site, core]);
    assert.deepStrictEqual(
      filterAssistantGroupFeed(feed, core).map(
        (item) => item.kind === "request" && (item.block.requestId as string),
      ),
      ["m1"],
    );
    assert.strictEqual(filterAssistantGroupFeed(feed, null), feed);
    // A request the lead has not placed yet shows under any filter.
    const waiting = start({
      type: "snapshot",
      messages: [inRequest(1, 1), inRequest(2, 2, { projectId: site })],
      tasks: [],
      hasMore: false,
    });
    assert.deepStrictEqual(
      filterAssistantGroupFeed(assistantGroupRequestFeed(waiting), core).map(
        (item) => item.kind === "request" && (item.block.requestId as string),
      ),
      ["m1"],
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
  ] as const)("labels a %s task's reason %s", (status, reason, expected) => {
    const label = assistantGroupTaskReasonLabel({ status, reason });
    if (expected instanceof RegExp) assert.match(label ?? "", expected);
    else assert.strictEqual(label, expected);
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
  it.each([
    ["", jarvis, null],
    ["hello", jarvis, "Jarvis (lead) will route it"],
    ["hello", null, "Waits for a lead"],
    ["thanks @ada", jarvis, "To Ada"],
    ["@ada do it", jarvis, "To Ada"],
    ["@ada @betosilva do it", jarvis, "To Ada and Beto Silva"],
    ["@everyone go", null, "To everyone"],
    ["@ada @beto @jarvis go", null, "To everyone"],
    ["@nobody go", null, "Waits for a lead"],
  ] as const)("previews %j", (text, lead, expected) => {
    assert.strictEqual(assistantGroupRecipientsPreview(text, [ada, beto, jarvis], lead), expected);
  });

  it("previews a reply to its member and a one-member group to that member", () => {
    assert.strictEqual(
      assistantGroupRecipientsPreview("why?", [ada, beto], jarvis, "Beto"),
      "To Beto",
    );
    // A leading mention still wins over the reply.
    assert.strictEqual(
      assistantGroupRecipientsPreview("@ada why?", [ada, beto], null, "Beto"),
      "To Ada",
    );
    assert.strictEqual(assistantGroupRecipientsPreview("hi", [ada], null), "To Ada");
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
  const chat = start(
    snapshot(
      [
        message(1),
        message(2, { author: "assistant", kind: "routing" }),
        message(3, { author: "assistant" }),
        message(4),
        message(5, { author: "agent", kind: "notice" }),
      ],
      [],
    ),
  );
  it("puts the New line before the first message others wrote past the read position", () => {
    assert.strictEqual(assistantGroupLatestSeq(chat), 5);
    assert.strictEqual(assistantGroupNewSeq(chat, 0), 3);
    assert.strictEqual(assistantGroupNewSeq(chat, 3), 5);
    assert.strictEqual(assistantGroupNewSeq(chat, 5), null);
    assert.strictEqual(assistantGroupLatestSeq({ ...chat, messages: new Map() }), 0);
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

  it("announces a group once, when its work goes from open to none", () => {
    const chatOf = (working: boolean, preview: string | null) => ({
      latestSeq: 3,
      readSeq: 0,
      unreadCount: 1,
      working,
      preview,
    });
    const busy = { name: "Ops", chat: chatOf(true, null) };
    const idle = { name: "Ops", chat: chatOf(false, "All   done.\nShip it.") };
    assert.deepStrictEqual(assistantGroupFinished(busy, idle), {
      title: "Ops finished",
      body: "All done. Ship it.",
    });
    assert.isNull(assistantGroupFinished(idle, idle));
    assert.isNull(assistantGroupFinished(undefined, idle));
    assert.isNull(assistantGroupFinished(busy, busy));
    assert.isNull(assistantGroupFinished(busy, { name: "Ops" }));
    assert.isNull(
      assistantGroupFinished(busy, { ...idle, archivedAt: "2026-11-09T00:00:00.000Z" }),
    );
    assert.strictEqual(
      assistantGroupFinished(busy, { name: "Ops", chat: chatOf(false, "x".repeat(300)) })?.body
        .length,
      140,
    );
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
