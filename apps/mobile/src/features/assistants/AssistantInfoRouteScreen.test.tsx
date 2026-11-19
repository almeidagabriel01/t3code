import { applyAssistantGroupsEvent } from "@t3tools/client-runtime/assistantGroupChat";
import { DEFAULT_ASSISTANT_AUTONOMY } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  assistants: [] as unknown[],
  archived: [] as unknown[],
  teams: [] as unknown[],
  environmentIds: ["hub"],
  chat: null as unknown,
  workingNow: [] as unknown[],
  working: new Set<string>(),
  canAct: true,
  canGoBack: true,
  goBack: vi.fn(),
  navigate: vi.fn(),
  selectDetail: vi.fn(),
  openEditor: vi.fn(),
  openWork: vi.fn(),
  team: { chat: vi.fn(), edit: vi.fn(), settings: vi.fn() },
  flows: {
    openConversation: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    restore: vi.fn(),
  },
}));
type RowProps = {
  icon?: string;
  label: string;
  description?: string;
  detail?: string;
  leading?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
};
const ui = vi.hoisted(() => {
  const row = (props: RowProps) => (
    <p data-row={props.label}>
      {props.leading}
      {[props.icon && `(${props.icon})`, props.label, props.description, props.detail]
        .filter(Boolean)
        .join(" | ")}
    </p>
  );
  return {
    text: (props: { children?: ReactNode }) => <span>{props.children}</span>,
    row,
    pressable: (props: RowProps) => (
      <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
        {row(props)}
      </button>
    ),
  };
});
vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode; testID?: string }) => (
    <span data-testid={props.testID}>{props.children}</span>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: ui.text }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { title: string; children?: ReactNode }) => (
    <main>
      <h1>{props.title}</h1>
      {props.children}
    </main>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({ ListRowLayout: ui.row }));
vi.mock("../settings/components/SettingsModelPicker", () => ({
  useModelDisplayName: () => (selection: { model: string }) => `listed:${selection.model}`,
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: ui.pressable }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: ui.pressable }));
vi.mock("../../components/ui/Button", () => ({ Button: ui.pressable }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: mocks.assistants.map((assistant) => ({ environmentId: "hub", assistant })),
    archived: mocks.archived.map((assistant) => ({ environmentId: "hub", assistant })),
    teams: mocks.teams,
    environmentIds: mocks.environmentIds,
  }),
  useAssistantGroupChat: () => mocks.chat,
  useAssistantLiveWork: () => null,
  useAssistantStatus: () => ({
    of: (_environmentId: string, assistant: { id: string } | null) => ({
      mood: assistant && mocks.working.has(assistant.id) ? "working" : "idle",
      detail: assistant && mocks.working.has(assistant.id) ? "Working" : "Idle",
      since: null,
      reading: false,
      queued: 0,
    }),
  }),
  useAssistantSpend: (_environmentId: string, assistantId: string | null) => ({
    data: assistantId === null ? null : { spent: 3 },
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "hub", id: "web", title: "Web" },
    { environmentId: "hub", id: "api", title: "API" },
  ],
  useThreadShells: () => [
    {
      environmentId: "hub",
      id: "assistant:ada:1",
      title: "Ada chat",
      projectId: "web",
      modelSelection: { model: "claude-opus-5-5" },
    },
    { environmentId: "hub", id: "task-thread", title: "Fix login", projectId: "api" },
  ],
}));
vi.mock("@t3tools/client-runtime/assistantLiveWork", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assistantWorkingNow: () => mocks.workingNow,
}));
vi.mock("./assistantPresentation", () => ({
  AssistantAvatar: (props: { assistant: { id: string }; mood?: string }) => (
    <i>{`[${props.assistant.id}:${props.mood ?? ""}]`}</i>
  ),
  AssistantCluster: (props: { faces: Array<{ key: string; mood?: string }> }) => (
    <i data-testid="cluster">{props.faces.map((face) => `${face.key}:${face.mood}`).join(",")}</i>
  ),
  budgetSpendLine: (spend: { spent: number }) => `$${spend.spent} spent`,
  removedAssistantFace: (id: string) => ({ id, avatar: null, icon: null }),
  toolAccessLabel: (access: string) => `access:${access}`,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    goBack: mocks.goBack,
    canGoBack: () => mocks.canGoBack,
    navigate: mocks.navigate,
  }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("./assistantTeamTarget", () => ({ useOpenAssistantTeam: () => mocks.team }));
vi.mock("./assistantWorkTarget", () => ({ useOpenAssistantWork: () => mocks.openWork }));
vi.mock("./openAssistantEditor", () => ({ useOpenAssistantEditor: () => mocks.openEditor }));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: mocks.canAct, ...mocks.flows }),
  useAssistantTeamFlows: () => ({ canAct: mocks.canAct, ...mocks.flows }),
}));

import {
  AssistantGroupInfoRouteScreen,
  AssistantInfoRouteScreen,
} from "./AssistantInfoRouteScreen";

const assistant = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  role: "",
  scope: "projects",
  projectId: "web",
  projectIds: ["web", "api"],
  toolAccess: "read-only",
  askBeforeActing: false,
  budget: null,
  threadId: `assistant:${id}:1`,
  archivedAt: null,
  avatar: null,
  icon: null,
  autonomy: DEFAULT_ASSISTANT_AUTONOMY,
  ...extra,
});
const team = (extra: object = {}) => ({
  environmentId: "hub",
  team: {
    id: "crew",
    name: "Crew",
    memberIds: ["ada", "bo", "gone"],
    leadId: "bo",
    archivedAt: null,
    ...extra,
  },
});
const task = (id: string, status: string, extra: object = {}) => ({
  id,
  teamId: "crew",
  rootId: id,
  parentId: null,
  kind: "root",
  requestMessageId: "m1",
  ownerId: "ada",
  instruction: `do ${id}`,
  status,
  reason: null,
  threadId: "task-thread",
  createdAt: "2026-11-07T10:00:00Z",
  updatedAt: "2026-11-07T10:00:00Z",
  ...extra,
});
const groupChat = (tasks: object[]) =>
  applyAssistantGroupsEvent(null, {
    type: "snapshot",
    messages: [],
    tasks,
    hasMore: false,
  } as never);

let container: HTMLDivElement;
const mount = (node: ReactNode) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(node));
  return { [Symbol.dispose]: () => act(() => root.unmount()) };
};
const showAssistant = (assistantId = "ada") =>
  mount(
    <AssistantInfoRouteScreen
      route={
        { key: "k", name: "AssistantInfo", params: { environmentId: "hub", assistantId } } as never
      }
    />,
  );
const showGroup = () =>
  mount(
    <AssistantGroupInfoRouteScreen
      route={
        {
          key: "k",
          name: "AssistantGroupInfo",
          params: { environmentId: "hub", teamId: "crew" },
        } as never
      }
    />,
  );
const section = (title: string) =>
  [...container.querySelectorAll(`section[aria-label="${title}"] [data-row]`)].map(
    (node) => node.textContent,
  );
const press = (label: string) =>
  act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click(),
  );

beforeEach(() => {
  Object.assign(mocks, {
    assistants: [
      assistant("ada", "Ada", {
        role: "CFO",
        askBeforeActing: true,
        budget: { limitUsd: 10 },
        autonomy: { ...DEFAULT_ASSISTANT_AUTONOMY, onProblem: "fix-small" },
      }),
      assistant("bo", "Bo", { scope: "all" }),
    ],
    archived: [],
    teams: [team()],
    environmentIds: ["hub"],
    chat: groupChat([]),
    workingNow: [],
    working: new Set(),
    canAct: true,
    canGoBack: true,
  });
  for (const fn of [
    mocks.goBack,
    mocks.navigate,
    mocks.selectDetail,
    mocks.openEditor,
    mocks.openWork,
    ...Object.values(mocks.team),
    ...Object.values(mocks.flows),
  ])
    fn.mockReset();
});

describe("Assistant info", () => {
  it("shows who it is, where it works now, its groups and access, and acts on them", async () => {
    mocks.working = new Set(["ada"]);
    mocks.workingNow = [{ threadId: "task-thread", projectId: "api", face: "working" }];
    using _screen = showAssistant();
    expect(container.querySelector("h1")?.textContent).toBe("Assistant info");
    expect(container.textContent).toContain("[ada:working]AdaCFOWorking");
    expect(section("Working now")).toEqual(["[ada:working]Fix login | API | Running"]);
    expect(section("Projects")).toEqual(["Web", "API | Ada is working here"]);
    expect(section("Groups")).toEqual(["(person.2) | Crew"]);
    // Every row has its own icon and a value; the model reads as its environment lists it.
    expect(section("Access")).toEqual([
      "(key) | Tool access | access:read-only",
      "(questionmark.bubble) | Asks before acting | On",
      "(brain) | Model | listed:claude-opus-5-5",
      "(wrench.and.screwdriver) | When it finds a problem | Fix small things",
      "(gauge.with.dots.needle.50percent) | Spending limit | $3 spent",
    ]);

    await press("Fix login");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "hub", threadId: "task-thread" },
    });
    await press("Crew");
    expect(mocks.team.chat).toHaveBeenCalledWith("hub", "crew");
    await press("Open chat");
    expect(mocks.flows.openConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ada" }),
    );
    await press("Edit");
    expect(mocks.openEditor).toHaveBeenCalledWith("hub", expect.objectContaining({ id: "ada" }));
    await press("Work");
    expect(mocks.openWork).toHaveBeenCalledWith("hub", "ada");
    await press("Archive assistant");
    expect(mocks.flows.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "ada" }));
  });

  it("an all-projects lead with nothing running", () => {
    using _screen = showAssistant("bo");
    expect(section("Working now")).toEqual(["Nothing running"]);
    expect(section("Projects")).toEqual(["All projects"]);
    expect(section("Groups")).toEqual(["(person.2) | Crew | Lead"]);
    expect(section("Access")).toEqual([
      "(key) | Tool access | access:read-only",
      "(questionmark.bubble) | Asks before acting | Off",
      "(wrench.and.screwdriver) | When it finds a problem | Offer to fix",
    ]);
  });

  it("an archived one says so, hides Working now and restores", async () => {
    mocks.assistants = [];
    mocks.archived = [assistant("ada", "Ada", { archivedAt: "2026-11-01T00:00:00Z" })];
    using _screen = showAssistant();
    expect(container.querySelector('[data-testid="assistant-info-status"]')?.textContent).toBe(
      "Archived",
    );
    expect(section("Working now")).toEqual([]);
    await press("Restore");
    expect(mocks.flows.unarchive).toHaveBeenCalledWith(expect.objectContaining({ id: "ada" }));
  });

  it.each([
    { name: "a deleted one closes once its environment loaded", loaded: ["hub"], closes: true },
    { name: "it waits while the environment loads", loaded: [], closes: false },
  ])("$name", ({ loaded, closes }) => {
    mocks.environmentIds = loaded;
    using _screen = showAssistant("gone");
    expect(container.querySelector("h1")?.textContent).toBe("Assistant info");
    expect(mocks.goBack).toHaveBeenCalledTimes(closes ? 1 : 0);
  });
});

describe("Group info", () => {
  it("shows every member lead first, what runs now, and opens each editor", async () => {
    mocks.working = new Set(["bo"]);
    mocks.chat = groupChat([task("t1", "running"), task("t2", "queued")]);
    using _screen = showGroup();
    expect(container.querySelector("h1")?.textContent).toBe("Group info");
    expect(container.querySelector('[data-testid="cluster"]')?.textContent).toBe(
      "bo:working,ada:idle,gone:sleeping",
    );
    expect(container.querySelector('[data-testid="assistant-info-status"]')?.textContent).toBe(
      "3 members · 1 running",
    );
    expect(section("Working now")).toEqual(["[ada:working]do t1 | API | Running"]);
    expect(section("Members")).toEqual([
      expect.stringMatching(/^\[bo:working\]Bo \| Working · .+ \| Lead$/),
      expect.stringMatching(/^\[ada:idle\]Ada \| Idle · [^|]+$/),
      "[gone:sleeping]Assistant",
    ]);

    await press("Ada");
    expect(mocks.navigate).toHaveBeenCalledWith("AssistantInfo", {
      environmentId: "hub",
      assistantId: "ada",
    });
    await press("Open chat");
    expect(mocks.team.chat).toHaveBeenCalledWith("hub", "crew");
    await press("Edit group");
    expect(mocks.team.edit).toHaveBeenCalledWith("hub", "crew");
    await press("Group settings");
    await press("Instructions");
    await press("Memories");
    expect(mocks.team.settings).toHaveBeenCalledTimes(3);
    await press("Routines");
    expect(mocks.team.settings).toHaveBeenLastCalledWith("hub", "crew", "routines");
    await press("Archive group");
    expect(mocks.flows.archive).toHaveBeenCalledWith(expect.objectContaining({ id: "crew" }));
  });

  it("an archived group says so and restores; nothing running before the chat loads", async () => {
    mocks.teams = [team({ archivedAt: "2026-11-01T00:00:00Z" })];
    mocks.chat = null;
    using _screen = showGroup();
    expect(container.querySelector('[data-testid="assistant-info-status"]')?.textContent).toBe(
      "Archived",
    );
    expect(section("Working now")).toEqual([]);
    await press("Restore group");
    expect(mocks.flows.restore).toHaveBeenCalledWith(expect.objectContaining({ id: "crew" }));
  });

  it("a deleted group closes once its environment loaded", () => {
    mocks.teams = [];
    using _screen = showGroup();
    expect(mocks.goBack).toHaveBeenCalledOnce();
  });
});
