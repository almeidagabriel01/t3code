import { describe, expect, it } from "vite-plus/test";

import { threadOwnerResolver, type ThreadOwner, type ZoneShell } from "./sidebarZones.ts";
import {
  workingConsumerLine,
  workingItems,
  type WorkingItem,
  type WorkingShell,
} from "./workingConsumers.ts";

const group = "assistant:ada:g-0123456789abcdef";

type ShellPatch = Omit<Partial<WorkingShell>, "lineage"> & {
  readonly lineage?: { parentThreadId: string; relationshipToParent: "subagent" };
};

// Test ids stay plain strings; the brands only guard production call sites.
const shell = (id: string, patch: ShellPatch = {}) =>
  ({
    environmentId: "mac",
    id,
    title: id,
    providerInstanceId: "claude-work",
    archivedAt: null,
    delegatedFrom: null,
    sideChatOf: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    runtime: { status: "running" },
    blockedOnThreadWait: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    latestRun: null,
    pendingRequest: null,
    oldestPendingGuestMessageAt: null,
    ...patch,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: id,
      ...patch.lineage,
    },
  }) as unknown as WorkingShell & ZoneShell;

const vps = "vps" as WorkingShell["environmentId"];
const at = (minute: number) => ({ startedAt: `2026-11-19T10:0${minute}:00.000Z` });
const subagentOf = (parentThreadId: string) =>
  ({ parentThreadId, relationshipToParent: "subagent" }) as const;
const from = (threadId: string) => ({ environmentId: "mac", threadId }) as never;

const shells = [
  shell("plain", { latestRun: at(1) }),
  shell("assistant:ada:1", { latestRun: at(2) }),
  shell(group, { latestRun: at(3) }),
  shell("idle-child", { latestRun: at(4), lineage: subagentOf("plain"), runtime: null }),
  shell("live-child", { environmentId: vps, latestRun: at(5), lineage: subagentOf("plain") }),
  shell("assistant:ada:old", { latestRun: at(6), archivedAt: "2026-11-02T00:00:00.000Z" }),
  shell("assistant:ada:asks", { latestRun: at(7), hasPendingApprovals: true }),
  shell("task", { latestRun: at(8) }),
  shell("routed", { environmentId: vps, latestRun: at(9), delegatedFrom: from("assistant:ada:1") }),
];

const ownerOf = threadOwnerResolver({
  shells,
  taskAssistantByThreadKey: new Map([["mac:task", "mac:ada"]]),
  teamKeyByThreadKey: new Map([[`mac:${group}`, "mac:dev"]]),
  activeAssistantKeys: new Set(["mac:ada"]),
});

const teams = (runningMemberIds: string[]) =>
  [{ environmentId: "mac", team: { id: "dev", chat: { runningMemberIds } } }] as never;

const ref = (kind: string, threadId: string, environmentId: string, extra: object) => ({
  kind,
  threadId,
  environmentId,
  providerInstanceId: "claude-work",
  ...extra,
});

describe("workingItems", () => {
  it("lists assistants, their tasks and routed work, group members and subagents, newest first", () => {
    const items = workingItems({ shells, ownerOf, teams: teams(["ada", "bo"]) });
    expect(items.map((item) => [item.key, item.consumer, item.ownerAssistantId])).toEqual([
      // An assistant's work routed to a linked machine is the assistant's, on that machine.
      ["vps:routed", ref("assistant", "routed", "vps", { assistantId: "ada" }), "ada"],
      ["mac:task", ref("assistant", "task", "mac", { assistantId: "ada" }), "ada"],
      [
        "vps:live-child",
        ref("subagent", "live-child", "vps", {
          parentThreadId: "plain",
          parentEnvironmentId: "vps",
        }),
        null,
      ],
      [
        `mac:${group}`,
        ref("groupMember", group, "mac", { assistantId: "ada", groupId: "dev" }),
        "ada",
      ],
      [
        "mac:assistant:ada:1",
        ref("assistant", "assistant:ada:1", "mac", { assistantId: "ada" }),
        "ada",
      ],
      // Ada already shows through her group thread; Bo runs before his thread arrives.
      [
        "member:mac:dev:bo",
        {
          kind: "groupMember",
          environmentId: "mac",
          threadId: null,
          assistantId: "bo",
          groupId: "dev",
        },
        "bo",
      ],
    ]);
  });

  it("lists a linked machine's task for a project thread as that thread's subagent", () => {
    const remote = shell("remote", { environmentId: vps, delegatedFrom: from("plain") });
    const project = (): ThreadOwner => ({ kind: "project" });
    const [item] = workingItems({ shells: [remote], ownerOf: project, teams: [] });
    expect(item?.consumer).toMatchObject({
      kind: "subagent",
      environmentId: "vps",
      parentThreadId: "plain",
      parentEnvironmentId: "mac",
    });
  });

  it("does not add a running member whose thread waits on the user", () => {
    const asking = shell(group, { hasPendingApprovals: true });
    expect(workingItems({ shells: [asking], ownerOf, teams: teams(["ada"]) })).toEqual([]);
  });
});

describe("workingConsumerLine", () => {
  const names = {
    assistant: (_: string, id: string) => (id === "ada" ? "Ada" : undefined),
    group: (_: string, id: string) => (id === "dev" ? "Backend" : undefined),
    // The parent of a delegated task lives on the machine that delegated it.
    thread: (env: string, id: string) =>
      env === "mac" && id === "plain" ? "Fix login" : undefined,
    environment: (id: string) => (id === "vps" ? "VPS" : undefined),
  };

  it.each([
    [{ kind: "assistant", assistantId: "ada" }, "ada", "Ada · VPS"],
    [{ kind: "groupMember", assistantId: "ada", groupId: "dev" }, "ada", "Ada · Backend · VPS"],
    [
      { kind: "groupMember", assistantId: "gone", groupId: null },
      "gone",
      "Assistant · Group · VPS",
    ],
    [
      { kind: "subagent", parentThreadId: "plain", parentEnvironmentId: "vps" },
      "ada",
      "Subagent of Ada · VPS",
    ],
    [
      { kind: "subagent", parentThreadId: "plain", parentEnvironmentId: "mac" },
      null,
      "Subagent of Fix login · VPS",
    ],
    [
      {
        kind: "subagent",
        parentThreadId: "other",
        parentEnvironmentId: "mac",
        environmentId: "mac",
      },
      null,
      "Subagent of a thread",
    ],
  ] as const)("%o reads %s", (consumer, ownerAssistantId, expected) => {
    const item = { consumer: ref("", "t", "vps", consumer), ownerAssistantId };
    expect(
      workingConsumerLine(item as Pick<WorkingItem, "consumer" | "ownerAssistantId">, names),
    ).toBe(expected);
  });
});
