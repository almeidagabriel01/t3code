import { describe, expect, it } from "vite-plus/test";

import { threadOwnerResolver, type ThreadOwner, type ZoneShell } from "./sidebarZones.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { collectUsageSessions } from "./state/usageSessions.ts";
import {
  isWorkingShell,
  workingConsumerLine,
  workingThreadKeys,
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
    projectId: "site",
    providerInstanceId: "claude-work",
    modelSelection: { instanceId: "claude-work", model: "m" },
    deletedAt: null,
    updatedAt: "2026-11-19T10:00:00.000Z",
    archivedAt: null,
    delegatedFrom: null,
    sideChatOf: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    runtime: { status: "running", providerInstanceId: patch.providerInstanceId ?? "claude-work" },
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
  }) as unknown as WorkingShell & ZoneShell & EnvironmentThreadShell;

const none: ReadonlySet<string> = new Set();

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
    const items = workingItems({
      shells,
      ownerOf,
      teams: teams(["ada", "bo"]),
      openDecisionThreadKeys: none,
    });
    expect(items.map((item) => [item.key, item.consumer, item.ownerAssistantId])).toEqual([
      // An assistant's work routed to a linked machine is the assistant's, on that machine.
      ["vps:routed", ref("assistant", "routed", "vps", { assistantId: "ada" }), "ada"],
      ["mac:task", ref("assistant", "task", "mac", { assistantId: "ada" }), "ada"],
      ["vps:live-child", ref("subagent", "live-child", "vps", { parentThreadId: "plain" }), null],
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
      // A project thread with a turn in progress is working too.
      ["mac:plain", ref("thread", "plain", "mac", {}), null],
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
    const [item] = workingItems({
      shells: [remote],
      ownerOf: project,
      teams: [],
      openDecisionThreadKeys: none,
    });
    expect(item?.consumer).toMatchObject({
      kind: "subagent",
      environmentId: "vps",
      parentThreadId: "plain",
    });
  });

  it("does not add a running member whose thread waits on the user", () => {
    const asking = shell(group, { hasPendingApprovals: true });
    expect(
      workingItems({
        shells: [asking],
        ownerOf,
        teams: teams(["ada"]),
        openDecisionThreadKeys: none,
      }),
    ).toEqual([]);
  });
});

/**
 * One state, every surface: Activity's Working section and the sidebar's Working zone draw
 * `workingItems`, the Resource Manager marks `isWorkingShell`, and the usage bar's Sessions count
 * `collectUsageSessions` per provider instance. All must name the same working set.
 */
describe("working parity", () => {
  const codex = { providerInstanceId: "codex" as WorkingShell["providerInstanceId"] };
  const cases = [
    ["project thread mid-turn", shell("p-run"), "working"],
    [
      "project thread starting",
      shell("p-start", { runtime: { status: "starting" } as never }),
      "working",
    ],
    [
      "project thread waiting on its children",
      shell("p-wait", { blockedOnThreadWait: true }),
      "working",
    ],
    // Background work the agent waits on parks the run at idle; the turn is still open.
    [
      "project thread held by background work",
      shell("p-bg", { runtime: { status: "idle" } as never }),
      "working",
    ],
    // A live provider session with no turn has no runtime in the shell.
    ["project thread with an idle live session", shell("p-idle", { runtime: null }), "idle"],
    ["project thread asking approval", shell("p-ask", { hasPendingApprovals: true }), "needsYou"],
    ["project thread asking input", shell("p-input", { hasPendingUserInput: true }), "needsYou"],
    ["project thread waiting on a decision", shell("p-decide"), "needsYou"],
    ["assistant on the VPS", shell("assistant:ada:1", { environmentId: vps, ...codex }), "working"],
    [
      "assistant asking approval",
      shell("assistant:ada:2", { hasPendingApprovals: true }),
      "needsYou",
    ],
    ["group member", shell(group), "working"],
    [
      "subagent on the VPS",
      shell("sub-vps", { environmentId: vps, lineage: subagentOf("p-run"), ...codex }),
      "working",
    ],
    ["idle subagent", shell("sub-idle", { lineage: subagentOf("p-run"), runtime: null }), "idle"],
    ["side chat mid-turn", shell("side", { sideChatOf: "p-run" } as never), "off"],
    ["archived mid-turn", shell("old", { archivedAt: "2026-11-02T00:00:00.000Z" }), "off"],
    ["deleted mid-turn", shell("gone", { deletedAt: "2026-11-02T00:00:00.000Z" }), "off"],
    [
      "deleted subagent mid-turn",
      shell("sub-gone", { lineage: subagentOf("p-run"), deletedAt: "2026-11-02T00:00:00.000Z" }),
      "off",
    ],
    ["assistant waiting on a decision mid-turn", shell("assistant:ada:3"), "needsYou"],
    [
      "subagent whose run is on another account",
      shell("sub-moved", {
        lineage: subagentOf("p-run"),
        runtime: { status: "running", providerInstanceId: "codex" } as never,
      }),
      "working",
    ],
    // The run moved to another account; the usage bar and the consumer both follow the run.
    [
      "project thread whose run is on another account",
      shell("p-moved", { runtime: { status: "running", providerInstanceId: "codex" } as never }),
      "working",
    ],
    [
      "idle thread that selected another account",
      shell("p-switched", {
        runtime: null,
        modelSelection: { instanceId: "codex", model: "m" } as never,
      }),
      "idle",
    ],
  ] as const;
  const state = cases.map(([, thread]) => thread);
  const decisions = new Set(["mac:p-decide", "mac:assistant:ada:3"]);
  const owners = threadOwnerResolver({
    shells: state,
    taskAssistantByThreadKey: new Map(),
    teamKeyByThreadKey: new Map([[`mac:${group}`, "mac:dev"]]),
    activeAssistantKeys: new Set(["mac:ada"]),
  });
  const items = workingItems({
    shells: state,
    ownerOf: owners,
    teams: teams(["bo"]),
    openDecisionThreadKeys: decisions,
  });
  const listed = new Set(items.map((item) => item.key));
  // The desktop tray and both Resource Managers mark threads by this set.
  const marked = workingThreadKeys(items);
  const usage = (["mac", "vps"] as const).flatMap((environmentId) =>
    (["claude-work", "codex"] as const).flatMap((instanceId) =>
      collectUsageSessions({
        threads: state,
        instanceId: instanceId as never,
        environmentIds: [environmentId as never],
        working: marked,
        openDecisionThreadKeys: decisions,
        now: Date.parse("2026-11-19T10:30:00.000Z"),
      }).map((session) => ({ ...session, instanceId })),
    ),
  );
  const usageState = new Map(usage.map((s) => [`${s.environmentId}:${s.threadId}`, s.state]));

  it.each(cases)("%s is %s on every surface", (_, thread, expected) => {
    const key = `${thread.environmentId}:${thread.id}`;
    const working = expected === "working";
    expect(listed.has(key)).toBe(working);
    expect(marked.has(key)).toBe(working);
    expect(isWorkingShell(thread, decisions)).toBe(working);
    expect(usageState.get(key) === "working").toBe(working);
    // Need you, as Activity ranks it: approval, input, request or an open decision.
    if (expected === "needsYou") expect(usageState.get(key)).toBe("waiting");
    // A live session whose turn ended reads as Recent.
    if (expected === "idle") expect(usageState.get(key)).toBe("recent");
  });

  it("files each working thread under the account its consumer names", () => {
    const accountOf = new Map(
      items.flatMap((item) =>
        item.consumer.threadId === null ? [] : [[item.key, item.consumer.providerInstanceId]],
      ),
    );
    // The run moved to codex while the thread still names claude-work.
    expect(accountOf.get("mac:sub-moved")).toBe("codex");
    const working = usage.filter((s) => s.state === "working");
    expect(working.length).toBeGreaterThan(0);
    for (const session of working) {
      expect(accountOf.get(`${session.environmentId}:${session.threadId}`)).toBe(
        session.instanceId,
      );
    }
    expect(usage.find((s) => s.threadId === "p-switched")?.instanceId).toBe("codex");
  });

  it("counts the same working set everywhere, across environments", () => {
    const threadItems = items.filter((item) => item.shell !== null);
    const usageWorking = usage.filter((s) => s.state === "working");
    // Bo runs before his thread arrives: no thread, so no provider instance to count him under.
    expect(items.length - threadItems.length).toBe(1);
    expect(usageWorking.map((s) => `${s.environmentId}:${s.threadId}`).toSorted()).toEqual(
      threadItems.map((item) => item.key).toSorted(),
    );
    expect(state.filter((thread) => isWorkingShell(thread, decisions))).toHaveLength(
      threadItems.length,
    );
    expect([...marked].toSorted()).toEqual(threadItems.map((item) => item.key).toSorted());
    expect(new Set(threadItems.map((item) => item.consumer.environmentId))).toEqual(
      new Set(["mac", "vps"]),
    );
    expect(threadItems.map((item) => item.consumer.kind).toSorted()).toEqual([
      "assistant",
      "groupMember",
      "subagent",
      "subagent",
      "thread",
      "thread",
      "thread",
      "thread",
      "thread",
    ]);
  });
});

describe("workingConsumerLine", () => {
  const names = {
    assistant: (_: string, id: string) => (id === "ada" ? "Ada" : undefined),
    group: (_: string, id: string) => (id === "dev" ? "Backend" : undefined),
    thread: (_: string, id: string) => (id === "plain" ? "Fix login" : undefined),
    project: (_: string, id: string) => (id === "site" ? "Website" : undefined),
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
    [{ kind: "subagent", parentThreadId: "plain" }, "ada", "Subagent of Ada · VPS"],
    [{ kind: "subagent", parentThreadId: "plain" }, null, "Subagent of Fix login · VPS"],
    [
      { kind: "subagent", parentThreadId: "other", environmentId: "mac" },
      null,
      "Subagent of a thread",
    ],
    [{ kind: "thread" }, null, "Website · VPS"],
  ] as const)("%o reads %s", (consumer, ownerAssistantId, expected) => {
    const item = { consumer: ref("", "t", "vps", consumer), ownerAssistantId, shell: shell("t") };
    expect(
      workingConsumerLine(
        item as unknown as Pick<WorkingItem, "consumer" | "ownerAssistantId" | "shell">,
        names,
      ),
    ).toBe(expected);
  });
});
