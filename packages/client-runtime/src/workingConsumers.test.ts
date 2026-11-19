import { describe, expect, it } from "vite-plus/test";

import { threadOwnerResolver } from "./sidebarZones.ts";
import { workingConsumerLine, workingItems, type WorkingShell } from "./workingConsumers.ts";

const running = { status: "running", providerInstanceId: "claude-work" } as WorkingShell["runtime"];

const shell = (id: string, extra: Partial<WorkingShell> = {}): WorkingShell => ({
  environmentId: "mac",
  id,
  archivedAt: null,
  lineage: { parentThreadId: null, relationshipToParent: null },
  delegatedFrom: null,
  pendingRequest: null,
  oldestPendingGuestMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  pendingGuestMessageCount: 0,
  runtime: running,
  blockedOnThreadWait: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  sideChatOf: null,
  latestRun: null,
  modelSelection: { instanceId: "codex" },
  ...extra,
});

const at = (minute: number) => ({ startedAt: `2026-11-19T10:0${minute}:00.000Z` });

const shells = [
  shell("plain", { latestRun: at(1) }),
  shell("assistant:ada:1", { latestRun: at(2) }),
  shell("assistant:ada:g-1", { latestRun: at(3) }),
  shell("child", {
    latestRun: at(4),
    lineage: { parentThreadId: "plain", relationshipToParent: "subagent" },
    runtime: null,
  }),
  shell("live-child", {
    environmentId: "vps",
    latestRun: at(5),
    lineage: { parentThreadId: "plain", relationshipToParent: "subagent" },
  }),
  shell("assistant:ada:old", { latestRun: at(6), archivedAt: "2026-11-02T00:00:00.000Z" }),
  shell("assistant:ada:asks", { latestRun: at(7), hasPendingApprovals: true }),
];

const ownerOf = threadOwnerResolver({
  shells,
  taskAssistantByThreadKey: new Map(),
  teamKeyByThreadKey: new Map([["mac:assistant:ada:g-1", "mac:dev"]]),
  activeAssistantKeys: new Set(["mac:ada"]),
});

describe("workingItems", () => {
  it("lists assistants, group members and subagents that run, newest first", () => {
    const items = workingItems({
      shells,
      ownerOf,
      teams: [
        // Ada already shows through her group thread; Bo runs before his thread arrives.
        { environmentId: "mac", team: { id: "dev", chat: { runningMemberIds: ["ada", "bo"] } } },
        { environmentId: "mac", team: { id: "old", chat: {} } },
      ],
    });
    expect(items.map((item) => [item.key, item.consumer])).toEqual([
      [
        "vps:live-child",
        {
          kind: "subagent",
          environmentId: "vps",
          threadId: "live-child",
          assistantId: null,
          groupId: null,
          parentThreadId: "plain",
          providerInstanceId: "claude-work",
        },
      ],
      [
        "mac:assistant:ada:g-1",
        {
          kind: "groupMember",
          environmentId: "mac",
          threadId: "assistant:ada:g-1",
          assistantId: "ada",
          groupId: "dev",
          parentThreadId: null,
          providerInstanceId: "claude-work",
        },
      ],
      [
        "mac:assistant:ada:1",
        {
          kind: "assistant",
          environmentId: "mac",
          threadId: "assistant:ada:1",
          assistantId: "ada",
          groupId: null,
          parentThreadId: null,
          providerInstanceId: "claude-work",
        },
      ],
      [
        "member:mac:dev:bo",
        {
          kind: "groupMember",
          environmentId: "mac",
          threadId: null,
          assistantId: "bo",
          groupId: "dev",
          parentThreadId: null,
          providerInstanceId: null,
        },
      ],
    ]);
  });

  it("treats a linked environment's task as a subagent of the thread it runs for", () => {
    const delegated = shell("remote", {
      environmentId: "vps",
      delegatedFrom: { environmentId: "mac", threadId: "plain" },
    });
    const [item] = workingItems({
      shells: [delegated],
      ownerOf: () => ({ kind: "project" }),
      teams: [],
    });
    expect(item?.consumer).toMatchObject({
      kind: "subagent",
      environmentId: "vps",
      parentThreadId: "plain",
    });
  });

  it("reads an assistant's work routed to a linked environment as the assistant's, on that machine", () => {
    const routed = shell("routed", {
      environmentId: "vps",
      delegatedFrom: { environmentId: "mac", threadId: "assistant:ada:1" },
    });
    const all = [...shells, routed];
    const [item] = workingItems({
      shells: all,
      ownerOf: threadOwnerResolver({
        shells: all,
        taskAssistantByThreadKey: new Map(),
        teamKeyByThreadKey: new Map(),
        activeAssistantKeys: new Set(["mac:ada"]),
      }),
      teams: [],
    }).filter((entry) => entry.key === "vps:routed");
    expect(item?.consumer).toMatchObject({
      kind: "assistant",
      environmentId: "vps",
      assistantId: "ada",
      parentThreadId: null,
    });
  });

  it("does not add a running member whose thread waits on the user", () => {
    const asking = shell("assistant:bo:g-1", { hasPendingApprovals: true });
    const items = workingItems({
      shells: [asking],
      ownerOf: () => ({ kind: "assistant", assistantKey: "mac:bo", teamKey: "mac:dev" }),
      teams: [{ environmentId: "mac", team: { id: "dev", chat: { runningMemberIds: ["bo"] } } }],
    });
    expect(items).toEqual([]);
  });
});

describe("workingConsumerLine", () => {
  const names = {
    assistant: (_: string, id: string) => (id === "ada" ? "Ada" : undefined),
    group: (_: string, id: string) => (id === "dev" ? "Backend" : undefined),
    thread: (_: string, id: string) => (id === "plain" ? "Fix login" : undefined),
    environment: (id: string) => (id === "vps" ? "VPS" : undefined),
  };
  const consumer = {
    kind: "assistant",
    environmentId: "vps",
    threadId: "t",
    assistantId: "ada",
    groupId: null,
    parentThreadId: null,
    providerInstanceId: null,
  } as const;

  it.each([
    [{}, "Ada · VPS"],
    [{ kind: "groupMember", groupId: "dev" }, "Ada · Backend · VPS"],
    [{ kind: "groupMember", assistantId: "gone", groupId: "gone" }, "Assistant · Group · VPS"],
    [{ kind: "subagent", parentThreadId: "plain" }, "Subagent of Ada · VPS"],
    [
      { kind: "subagent", assistantId: null, parentThreadId: "plain" },
      "Subagent of Fix login · VPS",
    ],
    [{ kind: "subagent", assistantId: null, environmentId: "mac" }, "Subagent of a thread"],
  ] as const)("%o reads %s", (patch, line) => {
    expect(workingConsumerLine({ ...consumer, ...patch }, names)).toBe(line);
  });
});
