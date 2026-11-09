import { assert, describe, it } from "@effect/vitest";
import type {
  AssistantGroupMessage,
  AssistantGroupTask,
  AssistantGroupsEvent,
  AssistantId,
  AssistantTeamId,
  ThreadId,
} from "@t3tools/contracts";

import {
  applyAssistantGroupHistory,
  applyAssistantGroupsEvent,
  assistantGroupAuthorName,
  assistantGroupAwaitingRoute,
  assistantGroupBoundaryLabel,
  assistantGroupFeed,
  assistantGroupFinished,
  assistantGroupLatestSeq,
  assistantGroupNewSeq,
  assistantGroupMentionOptions,
  assistantGroupMentionQuery,
  assistantGroupTextParts,
  assistantGroupPauseReasonLabel,
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
      oldestAssistantGroupSeq({ messages: new Map(), tasks: new Map(), hasMore: false }),
    );
    // After a clear nothing of an earlier page comes back, even once new messages arrive.
    const cleared = start(snapshot([], [], false));
    const page = { messages: [message(2)], tasks: [], hasMore: false };
    assert.strictEqual(applyAssistantGroupHistory(cleared, page).messages.size, 0);
    const restarted = start(snapshot([message(1, { id: "fresh" } as never)], [], false));
    assert.strictEqual(applyAssistantGroupHistory(restarted, page).messages.size, 1);
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

  it("labels pauses in words and an unknown reason as paused", () => {
    assert.strictEqual(assistantGroupPauseReasonLabel("stopped"), "Stopped");
    assert.strictEqual(
      assistantGroupPauseReasonLabel("routing_failed"),
      "The lead could not route this",
    );
    assert.match(assistantGroupPauseReasonLabel("handoff_limit"), /hand-offs/);
    assert.strictEqual(assistantGroupPauseReasonLabel("brand_new"), "Paused");
    assert.strictEqual(assistantGroupPauseReasonLabel(null), "Paused");
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

  it("cuts a text into plain and mention runs, as the server reads it", () => {
    const text = "Oi @Beto Silva, e `@ada` ou ada@x.com; @ADA!";
    assert.deepStrictEqual(assistantGroupTextParts(text, [ada, beto]), [
      { start: 0, text: "Oi ", mention: false },
      { start: 3, text: "@Beto Silva", mention: true },
      { start: 14, text: ", e `@ada` ou ada@x.com; ", mention: false },
      { start: 39, text: "@ADA", mention: true },
      { start: 43, text: "!", mention: false },
    ]);
    assert.deepStrictEqual(assistantGroupTextParts("plain", [ada]), [
      { start: 0, text: "plain", mention: false },
    ]);
    assert.deepStrictEqual(assistantGroupTextParts("", [ada]), []);
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
