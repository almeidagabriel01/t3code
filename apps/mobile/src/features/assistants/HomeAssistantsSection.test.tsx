import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Mood = "idle" | "working" | "needs" | "failed";
type Presence = { mood: Mood; detail: string; since: string | null; queued?: number };

const { mocks } = vi.hoisted(() => ({
  mocks: {
    open: vi.fn(),
    editor: vi.fn(),
    work: vi.fn(),
    toggle: vi.fn(),
    openTeam: vi.fn(),
    chat: vi.fn(),
    archiveTeam: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    navigate: vi.fn(),
    reset: vi.fn(),
    archive: vi.fn(),
    teams: [] as Array<{
      environmentId: string;
      team: {
        id: string;
        name: string;
        memberIds: string[];
        chat?: { unreadCount: number; latestSeq: number };
      };
    }>,
    collapsed: false,
    showAll: false,
    tasks: [] as Array<{
      threadId: string;
      title: string;
      createdAt: string;
      dismissedAt?: string | null;
    }>,
    dismissTask: vi.fn(),
    toggleShowAll: vi.fn(),
    presence: {} as Record<string, Presence>,
    notified: new Set<string>(),
    projects: [] as Array<{ environmentId: string; id: string; title: string }>,
    active: [] as Array<{
      environmentId: string;
      assistant: {
        id: string;
        name: string;
        handle: string;
        threadId: string | null;
        role: string;
        scope: string;
        projectId: string;
      };
    }>,
  },
}));
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; testID?: string; className?: string }) => (
    <div data-testid={props.testID} className={props.className}>
      {props.children}
    </div>
  ),
  Pressable: (props: {
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { expanded?: boolean };
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
  scopedThreadKey: (ref: { environmentId: string; threadId: string }) =>
    `${ref.environmentId}:${ref.threadId}`,
}));
vi.mock("@t3tools/client-runtime/assistantRobot", () => ({
  assistantGroupThreadsOf: () => [],
  assistantGroupOwnerKey: () => undefined,
  assistantFace: (presence: { mood: string }) =>
    presence.mood === "needs" ? "waiting" : presence.mood,
  assistantQueuedLabel: (queued: number | undefined) =>
    queued !== undefined && queued > 0 ? `${queued} queued` : null,
  assistantPresence: (thread: { id: string } | null): Presence =>
    thread === null
      ? { mood: "idle", detail: "Idle", since: null }
      : (mocks.presence[thread.id] ?? { mood: "idle", detail: "Idle", since: null }),
}));
vi.mock("@t3tools/client-runtime/state/thread-attention", () => ({
  resolveSidebarThreadStatus: (thread: { id: string }) =>
    mocks.presence[thread.id]?.mood === "working" ? "working" : "ready",
  hasSidebarNotification: (thread: { id: string }) => mocks.notified.has(thread.id),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <b>spinner</b>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; className?: string; testID?: string }) => (
    <span className={props.className} data-testid={props.testID}>
      {props.children}
    </span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <s>{`symbol:${props.name}`}</s>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: Array<{ id: string; title: string; attributes?: { disabled?: boolean } }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          aria-label={`menu:${action.title}`}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-06T12:00:00Z") }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : { id: ref.threadId, lastVisitedAt: "x" },
  useQuietThreadShells: () => [
    ...mocks.active.flatMap((entry) =>
      entry.assistant.threadId === null
        ? []
        : [{ environmentId: entry.environmentId, id: entry.assistant.threadId }],
    ),
    ...mocks.tasks.map((task) => {
      const mood = mocks.presence[task.threadId]?.mood;
      return {
        environmentId: "hub",
        id: task.threadId,
        title: task.title,
        runtime:
          mood === "working"
            ? { status: "running" }
            : mood === "failed"
              ? { status: "failed" }
              : null,
      };
    }),
  ],
  useProjects: () => mocks.projects,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active, activeTeams: mocks.teams }),
  useAssistantTasks: (_environmentId: string, assistantId: string) =>
    assistantId === "a0" ? mocks.tasks : [],
}));
vi.mock("../threads/SubagentStatusDot", () => ({
  SubagentStatusDot: (props: { tone: string }) => <u>{`dot:${props.tone}`}</u>,
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { name: string }; mood?: string }) => (
    <i>{`av:${props.assistant.name}:${props.mood ?? "-"}`}</i>
  ),
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    canAct: true,
    openConversation: mocks.open,
    reset: mocks.reset,
    archive: mocks.archive,
    dismissTask: mocks.dismissTask,
  }),
  useAssistantTeamFlows: () => ({
    canAct: true,
    canMarkRead: true,
    archive: mocks.archiveTeam,
    markRead: mocks.markRead,
    markUnread: mocks.markUnread,
  }),
}));
vi.mock("./assistantTeamTarget", () => ({
  useOpenAssistantTeam: () => ({ edit: mocks.openTeam, chat: mocks.chat }),
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.editor }));
vi.mock("./assistantWorkTarget", () => ({ useOpenAssistantWork: () => mocks.work }));
vi.mock("../home/useHomeSectionPreferences", () => ({
  useHomeSectionPreferences: () => ({
    assistantsCollapsed: mocks.collapsed,
    toggleAssistants: mocks.toggle,
    assistantsShowAll: mocks.showAll,
    toggleAssistantsShowAll: mocks.toggleShowAll,
  }),
}));

import { HomeAssistantsSection } from "./HomeAssistantsSection";

const bot = (i: number, extra: object = {}) => ({
  environmentId: "hub",
  assistant: {
    id: `a${i}`,
    name: `Bot${i}`,
    handle: `bot${i}`,
    threadId: `t${i}`,
    role: "",
    scope: "all",
    projectId: "p0",
    ...extra,
  },
});
const make = (n: number) => Array.from({ length: n }, (_, i) => bot(i));
const team = (
  id: string,
  name: string,
  memberIds: string[],
  environmentId = "hub",
  chat?: { unreadCount: number; latestSeq: number },
) => ({
  environmentId,
  team: { id, name, memberIds, ...(chat === undefined ? {} : { chat }) },
});

let root: Root;
let container: HTMLDivElement;
const render = (sidebar = true, labels = new Map<string, string>()) =>
  act(() =>
    root.render(
      <HomeAssistantsSection gutter={4} sidebar={sidebar} environmentLabelById={labels} />,
    ),
  );
const byLabel = (label: string) =>
  container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(async () => byLabel(label)?.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  Object.assign(mocks, {
    collapsed: false,
    showAll: false,
    presence: {},
    notified: new Set(),
    active: make(2),
    teams: [],
    tasks: [],
    projects: [{ environmentId: "hub", id: "p1", title: "Website" }],
  });
  for (const fn of [
    mocks.open,
    mocks.dismissTask,
    mocks.toggle,
    mocks.editor,
    mocks.work,
    mocks.openTeam,
    mocks.navigate,
    mocks.reset,
    mocks.archive,
    mocks.markRead,
    mocks.markUnread,
    mocks.toggleShowAll,
  ]) {
    fn.mockReset();
  }
});
afterEach(() => act(() => root.unmount()));

describe("HomeAssistantsSection", () => {
  it("renders nothing without assistants or groups, but a group alone still shows", () => {
    mocks.active = [];
    render();
    expect(container.textContent).toBe("");
    mocks.teams = [team("g1", "Finance", [])];
    render();
    expect(container.textContent).toContain("Finance");
  });

  it("lists the unassigned assistants without a label, and toggles the whole section", async () => {
    render();
    expect(container.textContent).toContain("symbol:chevron.down");
    expect(container.textContent).not.toContain("Unassigned");
    expect(byLabel("Bot0")).not.toBeNull();
    await click("Assistants");
    expect(mocks.toggle).toHaveBeenCalledOnce();
  });

  it("lists assistants flat: needs you, working, then the rest, with one meta each", () => {
    mocks.active = [
      bot(0, { role: "CEO" }),
      bot(1),
      bot(2),
      bot(3, { scope: "project", projectId: "p1" }),
      bot(4, { scope: "project", projectId: "p1" }),
      bot(5, { scope: "project", projectId: "p9" }),
    ];
    mocks.teams = [team("g1", "Finance", ["a1"])];
    mocks.presence.t4 = { mood: "needs", detail: "Needs your approval in Finance", since: null };
    mocks.presence.t2 = { mood: "working", detail: "Reading the repo", since: null };
    mocks.presence.t1 = { mood: "failed", detail: "Last run failed", since: null };
    mocks.showAll = true;
    render(false);
    const text = container.textContent ?? "";
    for (const label of ["Unassigned", "Groups", "Idle"]) {
      expect(text).not.toContain(label);
    }
    const order = ["Bot4", "Bot2", "Bot0", "Bot1", "Bot3", "Bot5"].map((name) =>
      text.lastIndexOf(name),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
    const statuses = Array.from(container.querySelectorAll('[data-testid="assistant-status"]'));
    expect(statuses.map((node) => node.textContent)).toEqual([
      "Needs you",
      "Working",
      "Last run failed",
    ]);
    expect(statuses[1]?.className).toContain("text-adaptive-sky-600-400");
    expect(statuses[2]?.className).toContain("text-danger-foreground");
    const pills = Array.from(container.querySelectorAll('[data-testid="assistant-project"]'));
    expect(pills.map((node) => node.textContent)).toEqual(["All projects", "Website", "Project"]);
    expect(text).toContain("CEO");
    expect(text).toContain("av:Bot2:working");
    render(true);
    expect(container.querySelector('[data-testid="assistant-status"]')?.className).toContain(
      "text-warning-foreground",
    );
  });

  it("lists an assistant's tasks under it with their state, and opens one on tap", async () => {
    mocks.tasks = [
      { threadId: "w1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "w2", title: "Fix flaky test", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "w3", title: "Old chore", createdAt: "2026-10-01T00:00:00.000Z" },
      {
        threadId: "w4",
        title: "Dismissed chore",
        createdAt: "2026-10-02T00:00:00.000Z",
        dismissedAt: "2026-11-03T00:00:00.000Z",
      },
    ];
    mocks.presence.w1 = { mood: "working", detail: "Working", since: null };
    mocks.presence.w2 = { mood: "failed", detail: "Last run failed", since: null };
    render(false);
    const rows = Array.from(
      container.querySelectorAll('[data-testid="assistant-task-list"] button'),
    ).filter((row) => row.getAttribute("aria-label")?.includes(", "));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Add retry, Running",
      "Fix flaky test, Failed",
      "Old chore, Done",
    ]);
    expect(container.textContent).toContain("av:Bot0:working");
    await click("Fix flaky test, Failed");
    expect(mocks.open).toHaveBeenCalledWith({ threadId: "w2" });
    // Only finished and failed tasks can be dismissed: the running one has no menu.
    const dismiss = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="menu:Dismiss task"]',
    );
    expect(dismiss).toHaveLength(2);
    await act(async () => dismiss[0]?.click());
    expect(mocks.dismissTask).toHaveBeenCalledWith("w2");
    mocks.tasks = [];
    render(true);
    expect(container.querySelector('[data-testid="assistant-task-list"]')).toBeNull();
  });

  it("names the environment only when assistants live on several", () => {
    mocks.active = [bot(0), { ...bot(1), environmentId: "lab" }];
    render(
      true,
      new Map([
        ["hub", "Home Mac"],
        ["lab", "Lab"],
      ]),
    );
    expect(container.textContent).toContain("Home Mac");
    expect(container.textContent).toContain("Lab");
    mocks.active = make(2);
    render(true, new Map([["hub", "Home Mac"]]));
    expect(container.textContent).not.toContain("Home Mac");
    mocks.active = [bot(0), { ...bot(1), environmentId: "lab" }];
    render(true, new Map());
    expect(container.textContent).not.toContain("Lab");
  });

  it("a group with unread messages shows a count and offers Mark as read; otherwise Mark as unread", async () => {
    mocks.teams = [
      team("g1", "Busy", [], "hub", { unreadCount: 120, latestSeq: 130 }),
      team("g2", "Quiet", [], "hub", { unreadCount: 0, latestSeq: 5 }),
      team("g3", "Empty", [], "hub", { unreadCount: 0, latestSeq: 0 }),
    ];
    render();
    const badges = Array.from(container.querySelectorAll('[data-testid="group-unread"]'));
    expect(badges.map((node) => node.textContent)).toEqual(["99+"]);
    expect(byLabel("Busy actions")).not.toBeNull();
    expect(container.querySelectorAll('[aria-label="menu:Mark as read"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="menu:Mark as unread"]')).toHaveLength(2);
    // A group with no messages has nothing to mark.
    const unread = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="menu:Mark as unread"]',
    );
    expect([unread[0]!.disabled, unread[1]!.disabled]).toEqual([false, true]);
    await act(async () => byLabel("menu:Mark as read")?.click());
    expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await act(async () => unread[0]!.click());
    expect(mocks.markUnread).toHaveBeenCalledWith(expect.objectContaining({ id: "g2" }));
  });

  it("a group is one row: avatars with +N, running or empty status, members behind the chevron", async () => {
    mocks.active = make(8);
    mocks.teams = [
      team("g1", "Everyone", ["a0", "a1", "a2", "a3", "a4", "a5"]),
      team("g2", "Nobody", []),
      team("g3", "Idle", ["a2", "a3", "a4", "a5", "a6", "a7"]),
    ];
    mocks.presence.t0 = { mood: "working", detail: "W", since: null };
    mocks.presence.t1 = { mood: "working", detail: "W", since: null };
    mocks.showAll = true;
    render();
    // The tablet bar drops a running group's faces so its name stays whole.
    const stacks = container.querySelectorAll('[data-testid="group-avatars"]');
    expect(stacks).toHaveLength(2);
    const stack = stacks[1]!;
    expect(stack.querySelectorAll("i")).toHaveLength(4);
    expect(stack.textContent).toContain("+2");
    const statuses = Array.from(container.querySelectorAll('[data-testid="group-status"]'));
    expect(statuses.map((node) => node.textContent)).toEqual(["spinner2 running", "empty"]);
    expect(byLabel("Show Nobody members")).toBeNull();
    const bot0 = () => container.querySelectorAll('[aria-label^="Bot0"]').length;
    expect(bot0()).toBe(2);
    await click("Show Everyone members");
    expect(bot0()).toBe(4);
    expect(byLabel("Hide Everyone members")?.getAttribute("aria-expanded")).toBe("true");
    await click("Hide Everyone members");
    expect(bot0()).toBe(2);
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("shows active assistants plus five recent ones, and Show all reveals the rest", async () => {
    mocks.active = make(9);
    mocks.presence.t8 = { mood: "working", detail: "W", since: null };
    render();
    const rows = () =>
      container.querySelectorAll('[aria-label^="Bot"]:not([aria-label*="actions"])');
    expect(rows()).toHaveLength(6);
    expect(byLabel("Bot7")).toBeNull();
    expect(container.textContent).toContain("Show all (9)");
    await click("Show all");
    expect(mocks.toggleShowAll).toHaveBeenCalledOnce();
    mocks.showAll = true;
    render();
    expect(byLabel("Bot7")).not.toBeNull();
    expect(byLabel("Show less")).not.toBeNull();
    mocks.showAll = false;
    mocks.active = make(3);
    render();
    expect(byLabel("Show all")).toBeNull();
  });

  it("opens a conversation from a row", async () => {
    render();
    await click("Bot1");
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("a row's menu resets, opens settings and archives; reset waits while it works", async () => {
    render();
    await click("menu:Reset conversation");
    expect(mocks.reset).toHaveBeenCalledWith(expect.objectContaining({ id: "a0" }), {
      openAfter: true,
    });
    await click("menu:Bot0 settings");
    expect(mocks.editor).toHaveBeenCalledWith("hub", expect.objectContaining({ id: "a0" }));
    await click("menu:Bot0 work");
    expect(mocks.work).toHaveBeenCalledWith("hub", "a0");
    await click("menu:Archive assistant");
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "a0" }));
    mocks.presence.t0 = { mood: "working", detail: "Working", since: null };
    render();
    expect(byLabel("menu:Reset conversation")?.disabled).toBe(true);
  });

  it("tapping a group opens its chat; its menu opens it, archives it, edits it and starts an assistant in it", async () => {
    mocks.teams = [team("g1", "Finance", ["a0"])];
    render();
    await click("Finance");
    expect(mocks.chat).toHaveBeenCalledWith("hub", "g1");
    mocks.chat.mockClear();
    await click("menu:Open chat");
    expect(mocks.chat).toHaveBeenCalledWith("hub", "g1");
    await click("menu:Archive group");
    expect(mocks.archiveTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    await click("menu:Edit group");
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", "g1");
    await click("menu:New assistant in this group");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
  });

  it("the plus menu offers a new assistant, a new group and the describe flow", async () => {
    render();
    await click("menu:New assistant");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null);
    await click("menu:New group");
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", null);
    await click("menu:Describe one and let T3 build it");
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsAssistantDescribe");
  });

  it("collapsed: shows five avatars then +N, and an avatar opens its conversation", async () => {
    mocks.collapsed = true;
    mocks.active = make(7);
    render();
    expect(container.textContent).toContain("symbol:chevron.right");
    expect(container.textContent).toContain("+2");
    expect(byLabel("Bot4")).not.toBeNull();
    expect(byLabel("Bot5")).toBeNull();
    await click("Bot1");
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    await click("2 more assistants");
    expect(mocks.toggle).toHaveBeenCalledOnce();
    expect(byLabel("Add")).not.toBeNull();
    expect(container.textContent).not.toContain("Groups");
  });

  it.each([
    ["working", "Bot0, working", "dot:working"],
    ["attention", "Bot0, needs attention", "dot:completed"],
  ] as const)("collapsed avatar shows %s state", (status, label, dot) => {
    mocks.collapsed = true;
    mocks.active = make(1);
    if (status === "working") mocks.presence.t0 = { mood: "working", detail: "W", since: null };
    else mocks.notified.add("t0");
    render();
    expect(byLabel(label)?.textContent).toContain(dot);
  });

  it("expanded rows show the working and attention dots", () => {
    mocks.presence.t0 = { mood: "working", detail: "W", since: null };
    render();
    expect(container.textContent).toContain("dot:working");
    mocks.presence = {};
    mocks.notified.add("t0");
    render();
    expect(container.textContent).toContain("dot:completed");
  });

  it("an assistant without a thread cannot be opened", () => {
    mocks.active = [bot(0, { threadId: null })];
    render();
    expect(byLabel("Bot0")?.disabled).toBe(true);
  });
});
