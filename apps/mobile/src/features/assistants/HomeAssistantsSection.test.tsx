import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Mood = "idle" | "working" | "needs" | "failed";
type Presence = { mood: Mood; detail: string; since: string | null };

const { mocks } = vi.hoisted(() => ({
  mocks: {
    open: vi.fn(),
    editor: vi.fn(),
    toggle: vi.fn(),
    openTeam: vi.fn(),
    navigate: vi.fn(),
    reset: vi.fn(),
    archive: vi.fn(),
    teams: [] as Array<{
      environmentId: string;
      team: { id: string; name: string; memberIds: string[] };
    }>,
    collapsed: false,
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
  useQuietThreadShells: () =>
    mocks.active.flatMap((entry) =>
      entry.assistant.threadId === null
        ? []
        : [{ environmentId: entry.environmentId, id: entry.assistant.threadId }],
    ),
  useProjects: () => mocks.projects,
}));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: mocks.active, teams: mocks.teams }),
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
  }),
}));
vi.mock("./assistantTeamTarget", () => ({
  useOpenAssistantTeam: () => ({ edit: mocks.openTeam }),
}));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.editor }));
vi.mock("../home/useHomeSectionPreferences", () => ({
  useHomeSectionPreferences: () => ({
    assistantsCollapsed: mocks.collapsed,
    toggleAssistants: mocks.toggle,
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
const team = (id: string, name: string, memberIds: string[], environmentId = "hub") => ({
  environmentId,
  team: { id, name, memberIds },
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
    presence: {},
    notified: new Set(),
    active: make(2),
    teams: [],
    projects: [{ environmentId: "hub", id: "p1", title: "Website" }],
  });
  for (const fn of [
    mocks.open,
    mocks.toggle,
    mocks.editor,
    mocks.openTeam,
    mocks.navigate,
    mocks.reset,
    mocks.archive,
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

  it("splits Needs you, Groups, Projects and Unassigned, naming the project on a project assistant", () => {
    mocks.active = [
      bot(0),
      bot(1),
      bot(2),
      bot(3, { scope: "project", projectId: "p1" }),
      bot(4, { scope: "project", projectId: "p1" }),
      bot(5, { scope: "project", projectId: "p9" }),
    ];
    mocks.teams = [team("g1", "Finance", ["a1"])];
    mocks.presence.t4 = { mood: "needs", detail: "Needs your approval", since: null };
    render();
    const text = container.textContent ?? "";
    for (const label of [
      "Needs you · 1",
      "Groups",
      "Finance",
      "Projects",
      "Website",
      "Unassigned",
    ]) {
      expect(text).toContain(label);
    }
    expect(text.indexOf("Needs you · 1")).toBeLessThan(text.indexOf("Groups"));
    expect(text.indexOf("Groups")).toBeLessThan(text.indexOf("Projects"));
    expect(text.indexOf("Projects")).toBeLessThan(text.indexOf("Unassigned"));
    // A project assistant outside its own project listing names it; one under its project does not.
    expect(text).toContain("Website only · Needs your approval");
    expect(text).toContain("Project");
    expect(text).not.toContain("Website only · Idle");
  });

  it("shows the status line with its relative time, the role chip and the mood color", () => {
    mocks.active = [bot(0, { role: "CEO" }), bot(1)];
    mocks.presence.t0 = {
      mood: "working",
      detail: "Reading the repo",
      since: "2026-11-06T11:48:00Z",
    };
    mocks.presence.t1 = { mood: "failed", detail: "Last run failed", since: null };
    render(false);
    expect(container.textContent).toContain("CEO");
    const [first, second] = Array.from(
      container.querySelectorAll('[data-testid="assistant-status"]'),
    );
    expect(first?.textContent).toBe("Reading the repo · 12m");
    expect(first?.className).toContain("text-adaptive-sky-600-400");
    expect(second?.textContent).toBe("Last run failed");
    expect(second?.className).toContain("text-danger-foreground");
    expect(container.textContent).toContain("av:Bot0:working");
    expect(container.textContent).toContain("av:Bot1:failed");
    render(true);
    expect(container.querySelector('[data-testid="assistant-status"]')?.className).toContain(
      "text-adaptive-sky-600-400",
    );
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

  it("groups stack their members' avatars with +N, fold, and say No members yet when empty", async () => {
    mocks.active = make(6);
    mocks.teams = [
      team("g1", "Everyone", ["a0", "a1", "a2", "a3", "a4", "a5"]),
      team("g2", "Nobody", []),
    ];
    render();
    const stack = container.querySelector('[data-testid="group-avatars"]')!;
    expect(stack.querySelectorAll("i")).toHaveLength(4);
    expect(stack.textContent).toContain("+2");
    expect(container.textContent).toContain("No members yet");
    expect(byLabel("Bot0")).not.toBeNull();
    await click("Everyone");
    expect(byLabel("Bot0")).toBeNull();
    expect(byLabel("Everyone")?.getAttribute("aria-expanded")).toBe("false");
    await click("Nobody");
    expect(container.textContent).not.toContain("No members yet");
    await click("Everyone");
    expect(byLabel("Bot0")).not.toBeNull();
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
    await click("menu:Archive assistant");
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "a0" }));
    mocks.presence.t0 = { mood: "working", detail: "Working", since: null };
    render();
    expect(byLabel("menu:Reset conversation")?.disabled).toBe(true);
  });

  it("a group's menu edits it and starts an assistant in it", async () => {
    mocks.teams = [team("g1", "Finance", ["a0"])];
    render();
    await click("menu:Edit group");
    expect(mocks.openTeam).toHaveBeenCalledWith("hub", "g1");
    await click("menu:New assistant in this group");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null, { teamId: "g1" });
  });

  it("a project header folds and starts an assistant in that project", async () => {
    mocks.active = [bot(0, { scope: "project", projectId: "p1" })];
    render();
    await click("menu:New assistant in this project");
    expect(mocks.editor).toHaveBeenCalledWith("hub", null, { projectId: "p1" });
    await click("Website");
    expect(byLabel("Bot0")).toBeNull();
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

  it("expanded rows show the working spinner and attention dot", () => {
    mocks.presence.t0 = { mood: "working", detail: "W", since: null };
    render();
    expect(container.textContent).toContain("spinner");
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
