import { describe, expect, it } from "vite-plus/test";

import {
  assistantIndicator,
  assistantStatus,
  assistantStatusOf,
  countWaits,
  folderAttention,
  folderIndicator,
  needsYouCards,
  needsYouDue,
  needsYouItems,
  teamsLayout,
  threadOwnerResolver,
  type ZoneShell,
} from "./sidebarZones.ts";

const shell = (id: string, extra: Partial<ZoneShell> = {}): ZoneShell => ({
  environmentId: "e",
  id,
  archivedAt: null,
  lineage: { parentThreadId: null },
  delegatedFrom: null,
  pendingRequest: null,
  oldestPendingGuestMessageAt: null,
  ...extra,
});

const shells = [
  shell("plain"),
  shell("task"),
  shell("task-child", { lineage: { parentThreadId: "task" } }),
  shell("assistant:ada:1"),
  shell("assistant:ada:g-1"),
  shell("chat-child", { lineage: { parentThreadId: "assistant:ada:1" } }),
  shell("delegated", { delegatedFrom: { environmentId: "e", threadId: "assistant:ada:1" } }),
  shell("assistant:gone:1"),
  shell("gone-task"),
  shell("loop-a", { lineage: { parentThreadId: "loop-b" } }),
  shell("loop-b", { lineage: { parentThreadId: "loop-a" } }),
];

const ownerOf = threadOwnerResolver({
  shells,
  taskAssistantByThreadKey: new Map([["e:task", "e:ada"]]),
  teamKeyByThreadKey: new Map([["e:assistant:ada:g-1", "e:dev"]]),
  activeAssistantKeys: new Set(["e:ada"]),
});

describe("threadOwnerResolver", () => {
  it.each([
    ["plain", { kind: "project" }],
    ["task", { kind: "assistant", assistantKey: "e:ada", teamKey: null }],
    ["task-child", { kind: "assistant", assistantKey: "e:ada", teamKey: null }],
    ["assistant:ada:1", { kind: "assistant", assistantKey: "e:ada", teamKey: null }],
    ["assistant:ada:g-1", { kind: "assistant", assistantKey: "e:ada", teamKey: "e:dev" }],
    ["chat-child", { kind: "assistant", assistantKey: "e:ada", teamKey: null }],
    ["delegated", { kind: "assistant", assistantKey: "e:ada", teamKey: null }],
    // An archived assistant's threads go back to their projects instead of vanishing.
    ["assistant:gone:1", { kind: "project" }],
    ["gone-task", { kind: "project" }],
    ["loop-a", { kind: "project" }],
    ["unknown", { kind: "project" }],
  ])("%s belongs to %o", (id, owner) => {
    expect(ownerOf({ environmentId: "e", id })).toEqual(owner);
  });
});

const decision = (id: string, extra: Record<string, unknown> = {}) => ({
  environmentId: "e",
  decision: {
    id,
    status: "open",
    fromThreadId: "plain",
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    ...extra,
  },
});

describe("needsYouItems", () => {
  it("lists user waits oldest first and leaves out what T3 answers or only mirrors", () => {
    const items = needsYouItems({
      shells: [
        // A guest waiting on the owner is its own item, timed by the guest's oldest message.
        shell("plain", {
          pendingRequest: { id: "r1", kind: "command", createdAt: "2026-01-01T00:00:05.000Z" },
          pendingGuestMessageCount: 2,
          oldestPendingGuestMessageAt: "2026-01-01T00:00:04.000Z",
        }),
        shell("task", {
          pendingGuestMessageCount: 1,
          oldestPendingGuestMessageAt: "2026-01-01T00:00:00.000Z",
        }),
        shell("resolved", { pendingGuestMessageCount: 0, oldestPendingGuestMessageAt: null }),
        // A waiting guest with no time neither leads nor vanishes: it lists last, as the newest.
        shell("untimed", { pendingGuestMessageCount: 1, oldestPendingGuestMessageAt: null }),
        shell("task-child", {
          pendingRequest: { id: "r2", kind: "user_input", createdAt: "2026-01-01T00:00:01.000Z" },
        }),
        shell("machine", {
          pendingRequest: {
            id: "r3",
            kind: "dynamic_tool_call",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        shell("archived", {
          archivedAt: "2026-01-01T00:00:00.000Z",
          pendingRequest: { id: "r4", kind: "command", createdAt: "2026-01-01T00:00:00.000Z" },
          pendingGuestMessageCount: 1,
          oldestPendingGuestMessageAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      decisions: [
        decision("d1"),
        decision("d22", { notice: true }),
        decision("d333", { approvalRequestId: "r1" }),
        decision("d4444", { status: "answered" }),
      ],
      ownerOf,
    });
    expect(items.map((item) => [item.key, item.kind, item.owner.kind])).toEqual([
      ["guest:e:task", "guest", "assistant"],
      ["request:e:r2", "question", "assistant"],
      ["decision:e:d1", "decision", "project"],
      ["guest:e:plain", "guest", "project"],
      ["request:e:r1", "approval", "project"],
      ["guest:e:untimed", "guest", "project"],
    ]);
  });
});

describe("teamsLayout", () => {
  const item = (
    id: string,
    mood: "idle" | "working" | "needs" | "failed" = "idle",
    activityAt = 0,
  ) => ({ entry: { environmentId: "e", assistant: { id } }, presence: { mood }, activityAt });
  it("draws each assistant once, in the first group that lists it", () => {
    const layout = teamsLayout({
      items: [],
      assistants: [item("jarvis"), item("ada"), item("bo"), item("cy")],
      teams: [
        { environmentId: "e", team: { id: "dev", memberIds: ["bo", "ada"] } },
        { environmentId: "e", team: { id: "ops", memberIds: ["ada", "cy", "ghost"] } },
        { environmentId: "e", team: { id: "empty", memberIds: [] } },
      ],
    });
    expect(
      layout.folders.map(({ team, members }) => [
        team.team.id,
        members.map((member) => member.entry.assistant.id),
      ]),
    ).toEqual([
      ["dev", ["ada", "bo"]],
      ["ops", ["cy"]],
      ["empty", []],
    ]);
    expect(layout.ungrouped.map((member) => member.entry.assistant.id)).toEqual(["jarvis"]);
  });

  it("orders folders by their own indicator: a wait, then running, then the latest activity", () => {
    const chat = { pausedTasks: 0, failedTasks: 0, unreadCount: 0 };
    const team = (id: string, memberIds: string[], extra: object = {}) => ({
      environmentId: "e",
      team: { id, memberIds, chat: { ...chat, ...extra } },
    });
    const waitingTab = { projectId: null, unreadCount: 0, waiting: true, readSeq: 0 };
    const layout = teamsLayout({
      items: [{ owner: { kind: "assistant" as const, assistantKey: "e:x", teamKey: "e:waits" } }],
      assistants: [item("old", "idle", 1), item("new", "idle", 9), item("busy", "working", 2)],
      teams: [
        team("stale", ["old"]),
        team("fresh", ["new"]),
        team("busy", ["busy"]),
        // A queued group task with no member working shows nothing, so it sorts with the rest.
        team("queued", [], { working: true }),
        team("tab", [], { scopes: [waitingTab] }),
        team("waits", []),
      ],
    });
    expect(
      layout.folders.map(({ team, needsYou, indicator }) => [
        team.team.id,
        needsYou,
        indicator?.kind ?? null,
      ]),
    ).toEqual([
      ["tab", 0, "needs"],
      ["waits", 1, "needs"],
      ["busy", 0, "running"],
      ["fresh", 0, null],
      ["stale", 0, null],
      ["queued", 0, null],
    ]);
  });
});

describe("indicators", () => {
  const owner = (assistantKey: string, teamKey: string | null = null) => ({
    owner: { kind: "assistant" as const, assistantKey, teamKey },
  });
  const items = [owner("e:ada"), owner("e:bo", "e:ops"), { owner: { kind: "project" as const } }];

  it("counts waits of drawn members and of the group's own threads", () => {
    expect(countWaits(items, { assistantKeys: new Set(["e:ada"]) })).toBe(1);
    expect(countWaits(items, { assistantKeys: new Set(["e:cy"]), teamKey: "e:ops" })).toBe(1);
    expect(countWaits(items, { assistantKeys: new Set(["e:ada", "e:bo"]), teamKey: "e:ops" })).toBe(
      2,
    );
    expect(countWaits(items, { assistantKeys: new Set() })).toBe(0);
  });

  const chat = { pausedTasks: 0, failedTasks: 0, unreadCount: 0 };
  it.each([
    [
      "needs you first",
      2,
      ["failed", "working"],
      { ...chat, pausedTasks: 1, unreadCount: 3 },
      { kind: "needs", count: 2 },
    ],
    [
      "a tab the server flags as waiting",
      0,
      ["failed"],
      { ...chat, scopes: [{ projectId: null, unreadCount: 0, waiting: true, readSeq: 0 }] },
      { kind: "needs", count: 1 },
    ],
    ["a failed member", 0, ["failed", "working"], chat, { kind: "failed" }],
    [
      "a usage-limited member",
      0,
      ["limited", "working"],
      { ...chat, pausedTasks: 1 },
      { kind: "limited" },
    ],
    ["a failed group task", 0, ["idle"], { ...chat, failedTasks: 1 }, { kind: "failed" }],
    [
      "paused group tasks",
      0,
      ["working"],
      { ...chat, pausedTasks: 2 },
      { kind: "paused", count: 2 },
    ],
    [
      "working members",
      0,
      ["working", "idle", "working"],
      { ...chat, unreadCount: 4 },
      { kind: "running", count: 2 },
    ],
    ["unread messages", 0, ["idle"], { ...chat, unreadCount: 4 }, { kind: "unread", count: 4 }],
    ["nothing", 0, ["idle"], null, null],
  ] as const)("a folder shows %s", (_name, needsYou, moods, folderChat, expected) => {
    expect(
      folderIndicator({ needsYou, members: moods.map((mood) => ({ mood })), chat: folderChat }),
    ).toEqual(expected);
  });

  it.each([
    [2, "needs", { kind: "needs", count: 2 }],
    [0, "failed", { kind: "failed" }],
    [0, "limited", { kind: "limited" }],
    [0, "working", { kind: "running", count: 1 }],
    [0, "idle", null],
    // A disconnected environment's assistant reads idle; its cached waits show nothing.
    [1, "idle", null],
  ] as const)("an assistant with %i waits and mood %s shows %o", (needsYou, mood, expected) => {
    expect(assistantIndicator({ needsYou, mood })).toEqual(expected);
  });

  const presence = (mood: "idle" | "working" | "needs" | "failed", detail = "Idle") => ({
    mood,
    detail,
    since: "2026-11-14T10:00:00.000Z",
    reading: false,
    queued: 0,
  });
  const site = (face: "working" | "waiting") => ({ face });
  it.each([
    // QA's task asked a question: Home says Needs you, so every screen does.
    [
      "a listed wait beats an idle chat",
      presence("idle"),
      1,
      [site("waiting")],
      true,
      "needs",
      "Needs you",
    ],
    [
      "a listed wait beats a working chat",
      presence("working", "Fixing it"),
      1,
      [],
      true,
      "needs",
      "Needs you",
    ],
    [
      "its own question keeps its detail",
      presence("needs", "Asked you a question"),
      1,
      [],
      true,
      "needs",
      "Asked you a question",
    ],
    [
      "a request T3 answers itself is work",
      presence("needs", "Needs your approval"),
      0,
      [],
      true,
      "working",
      "Working",
    ],
    [
      "a waiting task with no listed wait is work",
      presence("idle"),
      0,
      [site("waiting")],
      true,
      "working",
      "Working",
    ],
    [
      "a failed run beats work in a task",
      presence("failed", "Last run failed"),
      0,
      [site("working")],
      true,
      "failed",
      "Last run failed",
    ],
    [
      "its chat working keeps what it says",
      presence("working", "Fixing it"),
      0,
      [site("working")],
      true,
      "working",
      "Fixing it",
    ],
    [
      "a running task makes it work",
      presence("idle"),
      0,
      [site("working")],
      true,
      "working",
      "Working",
    ],
    ["nothing going on is idle", presence("idle"), 0, [], true, "idle", "Idle"],
    ["an unknown connection changes nothing", presence("idle"), 1, [], null, "needs", "Needs you"],
    [
      "a disconnected environment wins",
      presence("working", "Fixing it"),
      1,
      [site("waiting")],
      false,
      "idle",
      "This environment is disconnected",
    ],
  ] as const)("%s", (_name, own, needsYou, sites, reachable, mood, detail) => {
    const status = assistantStatus({ presence: own, needsYou, sites, reachable });
    expect([status.mood, status.detail]).toEqual([mood, detail]);
    // The sidebar row reads the same answer.
    expect(assistantIndicator({ needsYou, mood: status.mood })?.kind === "needs").toBe(
      mood === "needs",
    );
  });
});

describe("assistantStatusOf", () => {
  const thread = (id: string, extra: object = {}) =>
    ({
      ...shell(id),
      title: id,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
      pendingGuestMessageCount: 0,
      queuedMessageCount: 0,
      blockedOnThreadWait: false,
      latestRun: null,
      runtime: null,
      source: { latestVisibleMessage: null },
      ...extra,
    }) as never;
  const qa = { id: "qa", threadId: "assistant:qa:1" };
  const bo = { id: "bo", threadId: "assistant:bo:1" };
  const shells = [
    thread("assistant:qa:1"),
    thread("assistant:bo:1"),
    // QA's task asked the user a question; QA's own chat is idle.
    thread("ask-me", {
      hasPendingUserInput: true,
      pendingRequest: { id: "r1", kind: "user_input", createdAt: "2026-11-14T10:00:00.000Z" },
    }),
    thread("bo-task", { runtime: { status: "running" } }),
  ];
  const ownerOf = threadOwnerResolver({
    shells,
    taskAssistantByThreadKey: new Map([
      ["e:ask-me", "e:qa"],
      ["e:bo-task", "e:bo"],
    ]),
    teamKeyByThreadKey: new Map(),
    activeAssistantKeys: new Set(["e:qa", "e:bo"]),
  });
  const read = (reachable: boolean | null) =>
    assistantStatusOf({
      shells,
      decisions: [],
      ownerOf,
      sites: [
        {
          environmentId: "e",
          assistantId: "qa",
          projectId: "p",
          threadId: "ask-me",
          face: "waiting",
        },
        {
          environmentId: "e",
          assistantId: "bo",
          projectId: "p",
          threadId: "bo-task",
          face: "working",
        },
      ] as never,
      reachable: () => reachable,
    });

  it("reads each assistant from its own waits and tasks", () => {
    const status = read(true);
    expect(status.of("e", qa).mood).toBe("needs");
    expect(status.of("e", bo).mood).toBe("working");
    expect(status.of("e", null).mood).toBe("idle");
    expect(status.items.map((item) => item.threadId)).toEqual(["ask-me"]);
  });

  it("a usage limit says until when through the platform's label", () => {
    const limited = { id: "cap", threadId: "assistant:cap:1" };
    const status = assistantStatusOf({
      shells: [
        thread("assistant:cap:1", {
          runtime: {
            status: "failed",
            lastErrorClass: "usage_limit",
            usageLimitResetAt: "2026-11-14T15:30:00.000Z",
          },
        }),
      ],
      decisions: [],
      ownerOf,
      sites: [],
      reachable: () => true,
    });
    expect(status.of("e", limited).detail).toBe("Usage limit");
    expect(status.of("e", limited, (resetAt) => `Limit until ${resetAt}`).detail).toBe(
      "Limit until 2026-11-14T15:30:00.000Z",
    );
  });

  it("a disconnected environment reads disconnected for all", () => {
    const status = read(false);
    expect([status.of("e", qa).detail, status.of("e", bo).detail]).toEqual([
      "This environment is disconnected",
      "This environment is disconnected",
    ]);
  });
});

describe("folderAttention", () => {
  it.each([
    ["needs you", { kind: "needs", count: 1 }, [5], { tier: "needsYou", activityAt: 5 }],
    ["running", { kind: "running", count: 1 }, [2, 9], { tier: "working", activityAt: 9 }],
    ["failed", { kind: "failed" }, [3, 1], { tier: "rest", activityAt: 3 }],
    ["unread", { kind: "unread", count: 4 }, [4], { tier: "rest", activityAt: 4 }],
    ["nothing", null, [], { tier: "rest", activityAt: 0 }],
  ] as const)("%s", (_name, indicator, activity, expected) => {
    expect(
      folderAttention({ indicator, members: activity.map((activityAt) => ({ activityAt })) }),
    ).toEqual(expected);
  });
});

describe("needsYouDue", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  it.each([
    ["no deadline", undefined, null],
    ["an unreadable deadline", "soon", null],
    [
      "more than an hour away",
      "2026-01-01T13:00:00.001Z",
      { at: "2026-01-01T13:00:00.001Z", soon: false },
    ],
    [
      "exactly an hour away",
      "2026-01-01T13:00:00.000Z",
      { at: "2026-01-01T13:00:00.000Z", soon: false },
    ],
    [
      "under an hour away",
      "2026-01-01T12:59:59.999Z",
      { at: "2026-01-01T12:59:59.999Z", soon: true },
    ],
    ["already past", "2026-01-01T11:00:00.000Z", { at: "2026-01-01T11:00:00.000Z", soon: true }],
  ] as const)("%s", (_name, expiresAt, expected) => {
    expect(needsYouDue(expiresAt, now)).toEqual(expected);
  });
});

describe("needsYouCards", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  type Item = Parameters<typeof needsYouCards>[0][number];
  const item = (
    key: string,
    createdAt: string | null,
    owner: Item["owner"],
    decision: { readonly title: string; readonly expiresAt?: string } | "guest" | null = null,
  ): Item => {
    const base = { key, environmentId: "e", threadId: "t", createdAt, owner };
    if (decision === "guest") return { ...base, kind: "guest" };
    if (decision === null)
      return { ...base, kind: "approval", request: { id: key, kind: "command" } };
    return {
      ...base,
      kind: "decision",
      decision: {
        id: key,
        status: "open",
        fromThreadId: "t",
        createdAt: createdAt ?? "",
        ...decision,
      },
    };
  };

  it("names who asks and puts what expires within the hour first, then oldest first, a timeless guest last", () => {
    const cards = needsYouCards(
      [
        item("guest", null, { kind: "project" }, "guest"),
        item(
          "assistant",
          "2026-01-01T07:00:00.000Z",
          { kind: "assistant", assistantKey: "e:bo", teamKey: null },
          { title: "Pick a name", expiresAt: "2026-01-02T00:00:00.000Z" },
        ),
        item("old-request", "2026-01-01T08:00:00.000Z", { kind: "project" }),
        item(
          "group",
          "2026-01-01T09:00:00.000Z",
          { kind: "assistant", assistantKey: "e:ada", teamKey: "e:dev" },
          { title: "Ship it?", expiresAt: "2026-01-01T12:40:00.000Z" },
        ),
        item(
          "sooner",
          "2026-01-01T10:00:00.000Z",
          { kind: "project" },
          { title: "Now", expiresAt: "2026-01-01T12:10:00.000Z" },
        ),
      ],
      now,
    );
    expect(cards.map((card) => [card.key, card.from, card.title, card.due?.soon ?? null])).toEqual([
      ["sooner", { kind: "thread" }, "Now", true],
      ["group", { kind: "group", teamKey: "e:dev", assistantKey: "e:ada" }, "Ship it?", true],
      ["assistant", { kind: "assistant", assistantKey: "e:bo" }, "Pick a name", false],
      ["old-request", { kind: "thread" }, null, null],
      ["guest", { kind: "thread" }, null, null],
    ]);
  });
});
