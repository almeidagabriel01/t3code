import { describe, expect, it } from "vite-plus/test";

import {
  assistantIndicator,
  countWaits,
  folderIndicator,
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
        shell("plain", {
          pendingRequest: { id: "r1", kind: "command", createdAt: "2026-01-01T00:00:05.000Z" },
        }),
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
      ["request:e:r2", "question", "assistant"],
      ["decision:e:d1", "decision", "project"],
      ["request:e:r1", "approval", "project"],
    ]);
  });
});

describe("teamsLayout", () => {
  const item = (id: string) => ({ entry: { environmentId: "e", assistant: { id } } });
  it("draws each assistant once, in the first group that lists it", () => {
    const layout = teamsLayout({
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
    ["a failed member", 0, ["failed", "working"], chat, { kind: "failed" }],
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
    [1, "working", { kind: "needs", count: 1 }],
    [0, "failed", { kind: "failed" }],
    [0, "working", { kind: "running", count: 1 }],
    // A "needs" mood with no listed wait (a request T3 answers itself) shows nothing.
    [0, "needs", null],
    [0, "idle", null],
  ] as const)("an assistant with %i waits and mood %s shows %o", (needsYou, mood, expected) => {
    expect(assistantIndicator({ needsYou, mood })).toEqual(expected);
  });
});
