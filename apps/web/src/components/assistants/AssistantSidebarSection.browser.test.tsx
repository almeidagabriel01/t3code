import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "../../index.css";

import { render } from "../../../test/render";
import { useThreadTabsStore } from "../../threadTabsStore";
import { useUiStateStore } from "../../uiStateStore";
import { THREAD_TAB_DROP_EVENT, type ThreadTabDropDetail } from "../chat/threadContextDrag";
import { AssistantSidebarSection } from "./AssistantSidebarSection";
import type { AssistantTaskRowRenderer } from "./AssistantTaskRows";
import { useAssistantSidebarModel } from "./useAssistantSidebarModel";

type Spec = { name: string; role?: string; scope?: "all" | "project"; projectId?: string };

const state = vi.hoisted(() => ({
  specs: [] as Array<{
    name: string;
    role?: string;
    scope?: "all" | "project";
    projectId?: string;
  }>,
  enabled: true,
  collapsed: false,
  expanded: [] as string[],
  showAll: false,
  updated: {} as Record<string, string>,
  moods: {} as Record<string, "working" | "needs" | "failed">,
  queued: {} as Record<string, number>,
  settled: new Set<string>(),
  teams: [] as Array<{
    environmentId: string;
    team: { id: string; name: string; memberIds: string[] };
  }>,
  tasks: [] as Array<{
    threadId: string;
    title: string;
    createdAt: string;
    dismissedAt?: string | null;
  }>,
  work: {
    sites: [] as Array<Record<string, string>>,
    subagents: new Map<string, ReadonlyArray<Record<string, unknown>>>(),
  },
  dismissTask: vi.fn(),
  update: vi.fn(),
  openTeam: vi.fn(),
  openTeamDialog: vi.fn(),
  openGroupSettings: vi.fn(),
  openGroupRoutines: vi.fn(),
  openDialog: vi.fn(),
  archiveTeam: vi.fn(),
}));

const threadOf = (name: string) => `assistant:${name.toLowerCase()}:1`;
const shellFor = (threadId: string) => {
  const mood = state.moods[threadId];
  return {
    id: threadId,
    title:
      state.tasks.find((task) => task.threadId === threadId)?.title ??
      (threadId.includes(":g-") ? "Task · Growth" : threadId),
    updatedAt: state.updated[threadId] ?? "2020-01-01T00:00:00.000Z",
    environmentId: "env",
    lastVisitedAt: null,
    hasPendingApprovals: mood === "needs",
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    queuedMessageCount: state.queued[threadId] ?? 0,
    blockedOnThreadWait: false,
    latestRun: mood === "working" ? { startedAt: "2020-01-01T00:00:00.000Z" } : null,
    runtime:
      mood === "working" ? { status: "running" } : mood === "failed" ? { status: "failed" } : null,
    source: { latestVisibleMessage: null },
    ...(state.settled.has(threadId)
      ? { settledOverride: "settled", settledAt: "2020-01-02T00:00:00.000Z" }
      : { settledOverride: null }),
  };
};

vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({
    active: state.specs.map((spec) => ({
      environmentId: "env",
      assistant: {
        id: spec.name.toLowerCase(),
        name: spec.name,
        handle: spec.name.toLowerCase(),
        isDefault: spec.name === "Jarvis",
        threadId: threadOf(spec.name),
        role: spec.role ?? "",
        scope: spec.scope ?? "all",
        projectId: spec.projectId ?? "p0",
        avatar: null,
        icon: null,
      },
    })),
    archived: [],
    teams: state.teams,
    activeTeams: state.teams,
  }),
  useAssistantLiveWork: () => state.work,
  useAssistantTasks: () => state.tasks,
  useAssistantTasksByAssistant: () => new Map([["env:jarvis", state.tasks]]),
}));
vi.mock("./assistantTeamState", () => ({
  openAssistantTeamDialog: state.openTeamDialog,
  openAssistantGroupSettings: state.openGroupSettings,
  openAssistantGroupRoutines: state.openGroupRoutines,
}));
vi.mock("./assistantDialogState", () => ({ openAssistantDialog: state.openDialog }));
vi.mock("./DescribeAssistantDialog", () => ({
  DescribeAssistantDialog: (props: { open: boolean }) => (props.open ? <p>describe-open</p> : null),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : shellFor(ref.threadId),
  readThreadShell: () => null,
  useQuietThreadShells: () => [
    ...state.tasks.map((task) => ({ ...shellFor(task.threadId), environmentId: "env" })),
    ...state.specs.map((spec) => shellFor(threadOf(spec.name))),
    ...Object.keys(state.moods)
      .filter((id) => id.includes(":g-"))
      .map(shellFor),
  ],
  useProjects: () => [
    {
      environmentId: "env",
      id: "p1",
      title: "ProOps",
      workspaceRoot: "/home/user/proops",
      faviconPath: null,
      projectIcon: { kind: "monogram", text: "PO", color: "green" },
    },
  ],
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select({
      sidebarShowAssistantsSection: state.enabled,
      sidebarAssistantsCollapsed: state.collapsed,
      sidebarAssistantsExpandedGroups: state.expanded,
      sidebarAssistantsShowAll: state.showAll,
      sidebarShowSubagents: true,
      sidebarThreadOrder: "activity",
      sidebarAgentActivityDisplayMode: "compact",
    }),
  updateClientSettings: state.update,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({
    canAct: true,
    reset: vi.fn(),
    archive: vi.fn(),
    dismissTask: state.dismissTask,
  }),
  useAssistantTeamFlows: () => ({ canAct: true, archive: state.archiveTeam, restore: vi.fn() }),
}));

function setup(
  specs: Array<Spec | string>,
  options: {
    enabled?: boolean;
    collapsed?: boolean;
    expanded?: string[];
    showAll?: boolean;
    updated?: Record<string, string>;
    moods?: Record<string, "working" | "needs" | "failed">;
    queued?: Record<string, number>;
  } = {},
) {
  state.specs = specs.map((spec) => (typeof spec === "string" ? { name: spec } : spec));
  state.enabled = options.enabled ?? true;
  state.collapsed = options.collapsed ?? false;
  state.expanded = options.expanded ?? [];
  state.showAll = options.showAll ?? false;
  state.updated = options.updated ?? {};
  state.moods = options.moods ?? {};
  state.queued = options.queued ?? {};
  state.update.mockClear();
  state.teams = [];
  state.openTeam.mockClear();
  state.openTeamDialog.mockClear();
  state.openGroupSettings.mockClear();
  state.openGroupRoutines.mockClear();
  state.openDialog.mockClear();
  state.archiveTeam.mockClear();
  state.tasks = [];
  state.settled = new Set();
  state.work = { sites: [], subagents: new Map() };
  useUiStateStore.setState({ projectExpandedById: {} });
  state.dismissTask.mockClear();
}

function Section(props: {
  readonly onOpenThread: () => void;
  readonly routeThreadKey: string | null;
  readonly onOpenGroup: () => void;
  readonly renderTaskRow?: AssistantTaskRowRenderer;
  readonly onThreadContextMenu?: () => void;
}) {
  const model = useAssistantSidebarModel();
  return (
    <ul data-thread-keys={model.threadKeys.join(" ")}>
      <AssistantSidebarSection
        model={model}
        routeThreadKey={props.routeThreadKey}
        environmentLabelById={new Map()}
        onOpenThread={props.onOpenThread}
        onOpenGroup={props.onOpenGroup}
        jumpLabelByKey={new Map(model.threadKeys.map((key, index) => [key, `${index + 1}`]))}
        renderTaskRow={props.renderTaskRow}
        onThreadContextMenu={props.onThreadContextMenu}
      />
    </ul>
  );
}

const element = (
  onOpenThread = vi.fn(),
  routeThreadKey: string | null = null,
  onOpenGroup = vi.fn(),
  extra: Pick<Parameters<typeof Section>[0], "renderTaskRow" | "onThreadContextMenu"> = {},
) => (
  <Section
    onOpenThread={onOpenThread}
    routeThreadKey={routeThreadKey}
    onOpenGroup={onOpenGroup}
    {...extra}
  />
);
const threadKeys = (container: HTMLElement) =>
  container.querySelector("ul")?.getAttribute("data-thread-keys")?.split(" ").filter(Boolean) ?? [];

const team = (id: string, name: string, memberIds: string[]) => ({
  environmentId: "env",
  team: { id, name, memberIds },
});
const rows = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="sidebar-assistant-row"]');
const names = (container: HTMLElement) =>
  [...rows(container)].map((row) => row.getAttribute("data-sidebar-row")?.split(":").pop());
const status = (container: HTMLElement, name: string) =>
  container.querySelector(
    `[data-sidebar-row="assistant:env:${name}"] [data-testid="assistant-status"]`,
  );
const pill = (container: HTMLElement, name: string) =>
  container.querySelector(
    `[data-sidebar-row="assistant:env:${name}"] [data-testid="assistant-project"]`,
  );

describe("AssistantSidebarSection", () => {
  it("shows the projects an assistant works in and its live subagents, and opens each", async () => {
    setup([{ name: "Jarvis", scope: "project", projectId: "p1" }], {
      moods: { "child-1": "working" },
    });
    const site = { environmentId: "env", assistantId: "jarvis", face: "working" };
    state.work = {
      sites: [
        { ...site, projectId: "p1", threadId: "task-web" },
        // The assistants' own home, or a project this client does not list, shows no favicon.
        { ...site, projectId: "home", threadId: "child-home" },
      ],
      subagents: new Map([
        ["env:jarvis", [{ ...shellFor("child-1"), title: "Review the diff", createdAt: "x" }]],
      ]),
    };
    const onOpen = vi.fn();
    await using screen = await render(element(onOpen));
    const sites = screen.container.querySelectorAll('[data-testid="assistant-work-site"]');
    expect([...sites].map((node) => node.getAttribute("aria-label"))).toEqual([
      "Working in ProOps",
    ]);
    // The favicons replace the configured-project pill, so the row shows one set of projects.
    expect(pill(screen.container, "jarvis")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Working in ProOps" }));
    expect(onOpen).toHaveBeenLastCalledWith({ environmentId: "env", threadId: "task-web" });
    const child = screen.getByTestId("sidebar-subagent-row");
    await expect.element(child).toBeVisible();
    expect(child.element().textContent).toContain("Review the diff");
    await userEvent.click(child);
    expect(onOpen).toHaveBeenLastCalledWith({ environmentId: "env", threadId: "child-1" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("folds settled tasks into a Settled shelf and folds the whole list, persisted", async () => {
    setup(["Jarvis"], { moods: { "task-1": "working" } });
    state.settled = new Set(["task-2"]);
    state.tasks = [
      { threadId: "task-1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "task-2", title: "Old chore", createdAt: "2026-10-01T00:00:00.000Z" },
    ];
    await using screen = await render(element());
    const taskTitles = () =>
      [...screen.container.querySelectorAll('[data-testid="assistant-task-row"]')].map((row) =>
        row.getAttribute("aria-label"),
      );
    expect(taskTitles()).toEqual(["Add retry, Running"]);
    const shelf = screen.getByTestId("assistant-settled-toggle");
    await expect.element(shelf).toHaveTextContent("Settled1");
    await userEvent.click(shelf);
    expect(taskTitles()).toEqual(["Add retry, Running", "Old chore, Done"]);
    expect(useUiStateStore.getState().projectExpandedById["assistant:env:jarvis:settled"]).toBe(
      true,
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide Jarvis tasks" }));
    expect(taskTitles()).toEqual([]);
    expect(useUiStateStore.getState().projectExpandedById["assistant:env:jarvis"]).toBe(false);
    // The shelf stays open across the fold, as the numbering reads it from the same store.
    await userEvent.click(screen.getByRole("button", { name: "Show Jarvis tasks" }));
    expect(taskTitles()).toEqual(["Add retry, Running", "Old chore, Done"]);
  });

  it("numbers the rows it draws for ⌘1–9 and draws tasks with the sidebar's own rows", async () => {
    // child-3 finished; it stays listed because it is pinned.
    setup(["Jarvis"], {
      moods: { "task-1": "working", "child-1": "working", "child-2": "working" },
    });
    state.settled = new Set(["task-2"]);
    state.tasks = [
      { threadId: "task-1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "task-2", title: "Old chore", createdAt: "2026-10-01T00:00:00.000Z" },
    ];
    const child = (id: string, title: string, pin: Record<string, string> = {}) => ({
      ...shellFor(id),
      title,
      createdAt: id,
      pinnedAt: null,
      ...pin,
    });
    state.work = {
      sites: [],
      subagents: new Map([
        [
          "env:jarvis",
          [
            child("child-1", "Review the diff"),
            child("child-2", "Pinned later", { pinnedAt: "2026-11-02", pinOrderKey: "b" }),
            child("child-3", "Pinned first", { pinnedAt: "2026-11-03", pinOrderKey: "a" }),
          ],
        ],
      ]),
    };
    const renderTaskRow: AssistantTaskRowRenderer = (thread, section, assistantRow) => (
      <li key={thread.id} data-testid="full-task-row">
        {`${thread.title}|${section}|${assistantRow}`}
      </li>
    );
    const onMenu = vi.fn();
    await using screen = await render(
      element(vi.fn(), null, vi.fn(), { renderTaskRow, onThreadContextMenu: onMenu }),
    );
    const fullRows = () =>
      [...screen.container.querySelectorAll('[data-testid="full-task-row"]')].map(
        (row) => row.textContent,
      );
    expect(fullRows()).toEqual(["Add retry|active|assistant:env:jarvis"]);
    // Pinned subagents lead, in their pin order.
    expect(
      [...screen.container.querySelectorAll('[data-testid="sidebar-subagent-row"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Pinned first"),
      expect.stringContaining("Pinned later"),
      expect.stringContaining("Review the diff"),
    ]);
    const subagentRows = [
      ...screen.container.querySelectorAll('[data-testid="sidebar-subagent-row"]'),
    ];
    expect(
      subagentRows.map((row) => [
        row.getAttribute("data-status"),
        row.querySelector('[aria-label="Pinned"]') !== null,
      ]),
    ).toEqual([
      ["ready", true],
      ["working", true],
      ["working", false],
    ]);
    expect(threadKeys(screen.container)).toEqual([
      "env:assistant:jarvis:1",
      "env:task-1",
      "env:child-3",
      "env:child-2",
      "env:child-1",
    ]);
    expect(
      screen.container.querySelector('[data-sidebar-row="assistant:env:jarvis"] [data-jump-hint]')
        ?.textContent,
    ).toBe("1");
    // Every numbered subagent row wears its number.
    expect(
      [
        ...screen.container.querySelectorAll(
          '[data-testid="sidebar-subagent-row"] [data-jump-hint]',
        ),
      ].map((hint) => hint.textContent),
    ).toEqual(["3", "4", "5"]);

    await userEvent.click(screen.getByTestId("assistant-settled-toggle"));
    expect(fullRows()).toEqual([
      "Add retry|active|assistant:env:jarvis",
      "Old chore|settled|assistant:env:jarvis",
    ]);
    expect(threadKeys(screen.container)).toContain("env:task-2");

    const subagent = screen.container.querySelector('[data-testid="sidebar-subagent-row"]')!;
    subagent.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 8 }),
    );
    expect(onMenu).toHaveBeenCalledWith(
      { environmentId: "env", threadId: "child-3" },
      { x: 4, y: 8 },
    );

    await userEvent.click(screen.getByRole("button", { name: "Hide Jarvis tasks" }));
    expect(threadKeys(screen.container)).toEqual(["env:assistant:jarvis:1"]);
  });

  it("numbers nothing while the section is collapsed to its avatar strip", async () => {
    setup(["Jarvis"], { collapsed: true });
    await using screen = await render(element());
    expect(threadKeys(screen.container)).toEqual([]);
  });

  it("opens the assistant's own menu on right-click", async () => {
    setup(["Jarvis"]);
    await using screen = await render(element());
    const row = screen.container.querySelector('[data-sidebar-row="assistant:env:jarvis"]')!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Reset conversation" }))
      .toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "Archive assistant" })).toBeVisible();
  });

  it("drags the assistant chat into a split of the workspace on screen", async () => {
    setup(["Jarvis"]);
    useThreadTabsStore.setState({ byProject: {}, visibleKey: "env:p1" });
    await using screen = await render(element());
    const row = screen.container.querySelector('[data-sidebar-row="assistant:env:jarvis"]')!;
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    row.dispatchEvent(pointer("pointerdown", 1, 1));
    const pane = document.createElement("div");
    pane.setAttribute("data-thread-groups", "env:p1");
    pane.innerHTML = '<div data-thread-group-body="main" style="width:100%;height:100%"></div>';
    Object.assign(pane.style, { position: "fixed", inset: "0", zIndex: "50" });
    document.body.append(pane);
    using _pane = { [Symbol.dispose]: () => pane.remove() };
    const drops: ThreadTabDropDetail[] = [];
    pane.addEventListener(THREAD_TAB_DROP_EVENT, (event) =>
      drops.push((event as CustomEvent<ThreadTabDropDetail>).detail),
    );
    document.dispatchEvent(pointer("pointermove", 40, 40));
    document.dispatchEvent(pointer("pointerup", 40, 40));
    expect(drops).toEqual([
      {
        threadKey: "env:assistant:jarvis:1",
        target: { groupId: "main", zone: expect.any(String) },
      },
    ]);
  });

  it("drops the favicons and subagent rows once the work ends", async () => {
    setup([{ name: "Jarvis", scope: "project", projectId: "p1" }]);
    await using screen = await render(element());
    expect(screen.container.querySelector('[data-testid="assistant-work-sites"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="sidebar-subagent-row"]')).toBeNull();
    expect(pill(screen.container, "jarvis")).not.toBeNull();
    // Nothing under it, so nothing to fold.
    expect(screen.container.querySelector('[data-testid="assistant-fold"]')).toBeNull();
  });

  it("lists an assistant's tasks under it with their state, and opens one on click", async () => {
    setup(["Jarvis"], { moods: { "task-1": "working", "task-2": "failed" } });
    state.tasks = [
      { threadId: "task-1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "task-2", title: "Fix flaky test", createdAt: "2026-11-02T00:00:00.000Z" },
      { threadId: "task-3", title: "Old chore", createdAt: "2026-10-01T00:00:00.000Z" },
      {
        threadId: "task-4",
        title: "Dismissed chore",
        createdAt: "2026-10-02T00:00:00.000Z",
        dismissedAt: "2026-11-03T00:00:00.000Z",
      },
    ];
    const onOpen = vi.fn();
    await using screen = await render(element(onOpen, "env:task-3"));
    const tasks = [...screen.container.querySelectorAll('[data-testid="assistant-task-row"]')];
    expect(
      tasks.map((task) => [task.getAttribute("aria-label"), task.getAttribute("data-state")]),
    ).toEqual([
      ["Add retry, Running", "running"],
      ["Fix flaky test, Failed", "failed"],
      ["Old chore, Done", "done"],
    ]);
    expect(tasks[2]?.getAttribute("aria-current")).toBe("page");
    // A running task offers no dismiss; a finished one does, and a dismissed one is gone.
    expect(screen.container.querySelector('[aria-label="Dismiss Add retry"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss Fix flaky test" }));
    expect(state.dismissTask).toHaveBeenCalledWith("task-2");
    await userEvent.click(screen.getByRole("button", { name: "Add retry, Running" }));
    expect(onOpen).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("task-1"),
    });
  });

  it.each([
    { name: "has no assistants or groups", names: [], options: {} },
    { name: "is switched off", names: ["Jarvis"], options: { enabled: false } },
  ])("renders nothing when it $name", async ({ names, options }) => {
    setup(names, options);
    await using screen = await render(element());
    expect(screen.container.textContent).toBe("");
  });

  it("collapses to one line and expands back through the setting", async () => {
    setup(["Jarvis", "Revisor"]);
    await using screen = await render(element());
    expect(rows(screen.container)).toHaveLength(2);
    await expect.element(screen.getByRole("button", { name: "Add" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Collapse assistants" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsed: true });

    setup(["Jarvis", "Revisor"], { collapsed: true });
    await screen.rerender(element());
    expect(rows(screen.container)).toHaveLength(0);
    expect(screen.container.querySelector('[aria-label="Add"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Assistants, 2" }));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarAssistantsCollapsed: false });
  });

  it("opens an assistant from its avatar and caps the strip with +N", async () => {
    const all = ["Jarvis", "Revisor", "Pesquisador", "Aprovador", "Escritor", "Tradutor"];
    setup(all, { collapsed: true, moods: { [threadOf("Revisor")]: "working" } });
    const onOpen = vi.fn();
    await using screen = await render(element(onOpen, "env:assistant:jarvis:1"));
    const avatars = screen.container.querySelectorAll('button[aria-label^="Open "]');
    expect([...avatars].map((avatar) => avatar.getAttribute("aria-label"))).toEqual([
      "Open Revisor, working",
      "Open Aprovador",
      "Open Escritor",
      "Open Jarvis",
      "Open Pesquisador",
    ]);
    expect(avatars[3]?.getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "Open Revisor, working" }));
    expect(onOpen).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("assistant:revisor:1"),
    });
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show all 6 assistants" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsed: false });
  });

  it("lists assistants flat: needs you, working, then recent; no sub-headers; one meta each", async () => {
    setup(
      [
        { name: "Ada", role: "CFO", scope: "project", projectId: "p1" },
        { name: "Jarvis", role: "CEO" },
        "Pesquisador",
        { name: "Revisor", scope: "project", projectId: "p1" },
        { name: "Pedro", scope: "project", projectId: "p9" },
        "Aprovador",
      ],
      {
        moods: {
          [threadOf("Ada")]: "needs",
          [threadOf("Jarvis")]: "working",
          [threadOf("Aprovador")]: "failed",
        },
        updated: { [threadOf("Pedro")]: "2021-01-01T00:00:00.000Z" },
      },
    );
    await using screen = await render(element());
    expect(names(screen.container)).toEqual([
      "ada",
      "jarvis",
      "pedro",
      "aprovador",
      "pesquisador",
      "revisor",
    ]);
    expect(screen.container.querySelectorAll("li[aria-hidden]:not([data-testid])")).toHaveLength(0);
    expect(screen.container.textContent).not.toMatch(/Projects|Unassigned|Groups/);
    expect(status(screen.container, "ada")?.textContent).toBe("Needs you");
    expect(status(screen.container, "ada")?.getAttribute("data-mood")).toBe("needs");
    expect(status(screen.container, "jarvis")?.textContent).toBe("Working");
    expect(status(screen.container, "aprovador")?.textContent).toBe("Last run failed");
    // An active assistant shows its status instead of the project; an idle project one shows the pill.
    expect(pill(screen.container, "ada")).toBeNull();
    expect(pill(screen.container, "revisor")?.getAttribute("aria-label")).toBe("Project: ProOps");
    expect(pill(screen.container, "pedro")?.getAttribute("aria-label")).toBe("Project: Project");
    expect(pill(screen.container, "pesquisador")).toBeNull();
    expect(status(screen.container, "pesquisador")).toBeNull();
    expect(screen.container.querySelectorAll('[data-testid="assistant-role"]')).toHaveLength(2);
    expect(screen.container.querySelectorAll('[data-testid="assistant-status-dot"]')).toHaveLength(
      2,
    );
  });

  it("says where a group member works", async () => {
    setup(["Ada"], { moods: { "assistant:ada:g-0123456789abcdef": "working" } });
    await using screen = await render(element());
    expect(status(screen.container, "ada")?.textContent).toBe("Working in Growth");
  });

  it.each([
    { width: 296, text: false },
    { width: 420, text: true },
  ])(
    "shows the status text in a $width px row only if it fits; the dot's tooltip carries it",
    async ({ width, text }) => {
      setup(["Ada", "Aprovador"], {
        moods: { [threadOf("Ada")]: "needs", [threadOf("Aprovador")]: "failed" },
      });
      await using screen = await render(<div style={{ width }}>{element()}</div>);
      const shown = (name: string) =>
        getComputedStyle(status(screen.container, name)!).display !== "none";
      expect(shown("ada")).toBe(text);
      // A failed run has no dot to carry it, so its text stays.
      expect(shown("aprovador")).toBe(true);
      await userEvent.hover(
        screen.container.querySelector(
          '[data-sidebar-row="assistant:env:ada"] [data-slot="tooltip-trigger"]',
        )!,
      );
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toBe(
          "Needs you",
        ),
      );
    },
  );

  it("shows active assistants plus five recent ones and toggles Show all", async () => {
    const all = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
    setup(all, { moods: { [threadOf("A8")]: "working" } });
    await using screen = await render(element());
    expect(rows(screen.container)).toHaveLength(6);
    expect(names(screen.container)[0]).toBe("a8");
    await userEvent.click(screen.getByRole("button", { name: "Show all (8)" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsShowAll: true });

    setup(all, { showAll: true });
    await screen.rerender(element());
    expect(rows(screen.container)).toHaveLength(8);
    await userEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(state.update).toHaveBeenLastCalledWith({ sidebarAssistantsShowAll: false });

    setup(["A1", "A2"]);
    await screen.rerender(element());
    expect(screen.container.textContent).not.toMatch(/Show (all|less)/);
  });

  it("puts a group on one row, collapsed by default, with running or empty status", async () => {
    const members = ["Ada", "Bob", "Cid", "Dee", "Eve", "Fay"];
    setup(members, { moods: { [threadOf("Ada")]: "working", [threadOf("Bob")]: "working" } });
    state.teams = [
      team(
        "t1",
        "Growth",
        members.map((m) => m.toLowerCase()),
      ),
      team("t0", "Quiet", []),
    ];
    await using screen = await render(element());
    const groups = screen.container.querySelectorAll('[data-testid="sidebar-assistant-fold"]');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('[data-testid="group-status"]')?.textContent).toBe("2 running");
    expect(groups[1]?.querySelector('[data-testid="group-status"]')?.textContent).toBe("empty");
    expect(groups[0]?.querySelector('[data-testid="group-avatars"]')?.textContent).toBe("+2");
    // Only the flat list shows the members until the group is expanded.
    expect(rows(screen.container)).toHaveLength(6);
    expect(screen.container.querySelector('button[aria-label="Hide Quiet members"]')).toBeNull();
    expect(screen.container.querySelector('button[aria-label="Show Quiet members"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show Growth members" }));
    expect(state.update).toHaveBeenCalledWith({
      sidebarAssistantsExpandedGroups: ["group:env:t1"],
    });
    expect(state.openTeam).not.toHaveBeenCalled();
  });

  it("shows a group's members under it when expanded, and the chevron hides them again", async () => {
    setup(["Ada", "Bob"], { expanded: ["group:env:t1", "project:env:p1"] });
    state.teams = [team("t1", "Growth", ["ada", "bob", "ghost"])];
    const onOpenGroup = vi.fn();
    await using screen = await render(element(vi.fn(), null, onOpenGroup));
    expect(rows(screen.container)).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Hide Growth members" }));
    expect(state.update).toHaveBeenCalledWith({
      sidebarAssistantsExpandedGroups: ["project:env:p1"],
    });
    expect(onOpenGroup).not.toHaveBeenCalled();
  });

  it("opens the group chat from the row and the menu, and archives from the menu", async () => {
    setup(["Jarvis"]);
    state.teams = [team("t1", "Growth", ["jarvis"])];
    const onOpenGroup = vi.fn();
    await using screen = await render(element(vi.fn(), null, onOpenGroup));
    await userEvent.click(screen.getByRole("button", { name: "Growth", exact: true }));
    expect(onOpenGroup).toHaveBeenLastCalledWith("env", "t1");
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open chat" }));
    expect(onOpenGroup).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Archive group" }));
    expect(state.archiveTeam).toHaveBeenCalledWith({
      id: "t1",
      name: "Growth",
      memberIds: ["jarvis"],
    });
  });

  it("runs the group menu", async () => {
    setup(["Jarvis"]);
    state.teams = [team("t1", "Growth", ["jarvis"])];
    await using screen = await render(element());
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit group" }));
    expect(state.openTeamDialog).toHaveBeenCalledWith({ environmentId: "env", teamId: "t1" });
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Group settings" }));
    expect(state.openGroupSettings).toHaveBeenCalledWith({ environmentId: "env", teamId: "t1" });
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Group routines" }));
    expect(state.openGroupRoutines).toHaveBeenCalledWith({ environmentId: "env", teamId: "t1" });
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New assistant in this group" }));
    expect(state.openDialog).toHaveBeenCalledWith({
      environmentId: "env",
      preset: { teamId: "t1" },
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("adds an assistant, a group or a described one from the plus menu", async () => {
    setup(["Jarvis"]);
    await using screen = await render(element());
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New assistant" }));
    expect(state.openDialog).toHaveBeenCalledWith();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New group" }));
    expect(state.openTeamDialog).toHaveBeenCalledWith();
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Describe one and let T3 build it" }),
    );
    await expect.element(screen.getByText("describe-open")).toBeVisible();
    expect(state.update).not.toHaveBeenCalled();
  });
});
