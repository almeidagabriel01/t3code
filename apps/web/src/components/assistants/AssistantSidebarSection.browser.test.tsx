import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { AssistantSidebarSection } from "./AssistantSidebarSection";

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
  moods: {} as Record<string, "working" | "needs" | "failed" | "limited">,
  queued: {} as Record<string, number>,
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
  dismissTask: vi.fn(),
  update: vi.fn(),
  openTeam: vi.fn(),
  openTeamDialog: vi.fn(),
  openGroupSettings: vi.fn(),
  openGroupRoutines: vi.fn(),
  openDialog: vi.fn(),
  archiveTeam: vi.fn(),
}));

const LIMIT_RESET_AT = "2099-03-04T09:30:00.000Z";
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
      mood === "working"
        ? { status: "running" }
        : mood === "failed"
          ? { status: "failed" }
          : mood === "limited"
            ? { status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: LIMIT_RESET_AT }
            : null,
    source: { latestVisibleMessage: null },
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
  useAssistantTasks: (_environmentId: string, assistantId: string) =>
    assistantId === "jarvis" ? state.tasks : [],
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
      timestampFormat: "24-hour",
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
    moods?: Record<string, "working" | "needs" | "failed" | "limited">;
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
  state.dismissTask.mockClear();
}

const element = (
  onOpenThread = vi.fn(),
  routeThreadKey: string | null = null,
  onOpenGroup = vi.fn(),
) => (
  <ul>
    <AssistantSidebarSection
      routeThreadKey={routeThreadKey}
      environmentLabelById={new Map()}
      onOpenThread={onOpenThread}
      onOpenGroup={onOpenGroup}
    />
  </ul>
);

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
  it("lists an assistant's tasks under it with their state, and opens one on click", async () => {
    setup(["Jarvis"], { moods: { "task-1": "working", "task-2": "failed", "task-5": "limited" } });
    state.tasks = [
      { threadId: "task-1", title: "Add retry", createdAt: "2026-11-01T00:00:00.000Z" },
      { threadId: "task-5", title: "Port docs", createdAt: "2026-11-01T00:00:00.000Z" },
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
      [
        `Port docs, Limit until ${formatUpcomingTimestamp(LIMIT_RESET_AT, "24-hour")}`,
        "usage_limited",
      ],
      ["Fix flaky test, Failed", "failed"],
      ["Old chore, Done", "done"],
    ]);
    expect(tasks[3]?.getAttribute("aria-current")).toBe("page");
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
