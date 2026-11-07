import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
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
  folded: [] as string[],
  moods: {} as Record<string, "working" | "needs" | "failed">,
  teams: [] as Array<{
    environmentId: string;
    team: { id: string; name: string; memberIds: string[] };
  }>,
  update: vi.fn(),
  openTeam: vi.fn(),
  openTeamDialog: vi.fn(),
  openDialog: vi.fn(),
}));

const threadOf = (name: string) => `assistant:${name.toLowerCase()}:1`;
const shellFor = (threadId: string) => {
  const mood = state.moods[threadId];
  return {
    id: threadId,
    environmentId: "env",
    lastVisitedAt: null,
    hasPendingApprovals: mood === "needs",
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    blockedOnThreadWait: false,
    latestRun: mood === "working" ? { startedAt: "2020-01-01T00:00:00.000Z" } : null,
    runtime:
      mood === "working" ? { status: "running" } : mood === "failed" ? { status: "failed" } : null,
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
  }),
}));
vi.mock("./assistantTeamState", () => ({
  openAssistantTeamDialog: state.openTeamDialog,
}));
vi.mock("./assistantDialogState", () => ({ openAssistantDialog: state.openDialog }));
vi.mock("./DescribeAssistantDialog", () => ({
  DescribeAssistantDialog: (props: { open: boolean }) => (props.open ? <p>describe-open</p> : null),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : shellFor(ref.threadId),
  useQuietThreadShells: () => state.specs.map((spec) => shellFor(threadOf(spec.name))),
  useProjects: () => [{ environmentId: "env", id: "p1", title: "ProOps" }],
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select({
      sidebarShowAssistantsSection: state.enabled,
      sidebarAssistantsCollapsed: state.collapsed,
      sidebarAssistantsCollapsedGroups: state.folded,
    }),
  updateClientSettings: state.update,
}));
vi.mock("./useAssistantFlows", () => ({
  useAssistantFlows: () => ({ canAct: true, reset: vi.fn(), archive: vi.fn() }),
}));

function setup(
  specs: Array<Spec | string>,
  options: {
    enabled?: boolean;
    collapsed?: boolean;
    folded?: string[];
    moods?: Record<string, "working" | "needs" | "failed">;
  } = {},
) {
  state.specs = specs.map((spec) => (typeof spec === "string" ? { name: spec } : spec));
  state.enabled = options.enabled ?? true;
  state.collapsed = options.collapsed ?? false;
  state.folded = options.folded ?? [];
  state.moods = options.moods ?? {};
  state.update.mockClear();
  state.teams = [];
  state.openTeam.mockClear();
  state.openTeamDialog.mockClear();
  state.openDialog.mockClear();
}

const element = (onOpenThread = vi.fn(), routeThreadKey: string | null = null) => (
  <ul>
    <AssistantSidebarSection
      routeThreadKey={routeThreadKey}
      environmentLabelById={new Map()}
      onOpenThread={onOpenThread}
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
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("li[aria-hidden]")].map((li) => li.textContent).filter(Boolean);

describe("AssistantSidebarSection", () => {
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
      "Open Jarvis",
      "Open Revisor, working",
      "Open Pesquisador",
      "Open Aprovador",
      "Open Escritor",
    ]);
    expect(avatars[0]?.getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "Open Revisor, working" }));
    expect(onOpen).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("assistant:revisor:1"),
    });
    expect(state.update).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show all 6 assistants" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsed: false });
  });

  it("sorts assistants into needs-you, groups, projects and unassigned, each listed once", async () => {
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
      },
    );
    state.teams = [team("t1", "Leadership", ["ada", "jarvis", "pesquisador"])];
    await using screen = await render(element());
    expect(labels(screen.container)).toEqual(["Needs you · 1", "Groups", "Projects", "Unassigned"]);
    // Ada needs the user so only the first section lists her; Revisor sits under its project.
    expect(names(screen.container)).toEqual([
      "ada",
      "jarvis",
      "pesquisador",
      "revisor",
      "pedro",
      "aprovador",
    ]);
    const status = (name: string) =>
      screen.container.querySelector(
        `[data-sidebar-row="assistant:env:${name}"] [data-testid="assistant-status"]`,
      )!;
    expect(status("ada").getAttribute("data-mood")).toBe("needs");
    expect(status("ada").textContent).toContain("ProOps only · Needs your approval");
    expect(status("jarvis").getAttribute("data-mood")).toBe("working");
    expect(status("jarvis").textContent).toMatch(/^Working· .+/);
    expect(status("aprovador").textContent).toBe("Last run failed");
    expect(screen.container.querySelectorAll('[data-testid="assistant-role"]')).toHaveLength(2);
    await expect.element(screen.getByRole("button", { name: "ProOps" })).toBeVisible();
    // A project without a known name still lists its members.
    await expect.element(screen.getByRole("button", { name: "Project" })).toBeVisible();
  });

  it("omits the Unassigned label when it is the only list, and shows empty groups", async () => {
    setup(["Jarvis"]);
    state.teams = [team("t0", "Empty", [])];
    await using screen = await render(element());
    expect(labels(screen.container)).toEqual(["Groups", "Unassigned"]);
    expect(screen.container.textContent).toContain("No members yet");

    setup(["Jarvis"]);
    await screen.rerender(element());
    expect(labels(screen.container)).toEqual([]);
    expect(names(screen.container)).toEqual(["jarvis"]);
  });

  it("folds a group, remembers it, and caps the stacked avatars", async () => {
    const members = ["Ada", "Bob", "Cid", "Dee", "Eve", "Fay"];
    setup(members);
    state.teams = [
      team(
        "t1",
        "Growth",
        members.map((m) => m.toLowerCase()),
      ),
    ];
    await using screen = await render(element());
    expect(screen.container.querySelector('[data-testid="group-avatars"]')?.textContent).toBe("+2");
    await userEvent.click(screen.getByRole("button", { name: "Growth" }));
    expect(state.update).toHaveBeenCalledWith({
      sidebarAssistantsCollapsedGroups: ["group:env:t1"],
    });

    setup(members, { folded: ["group:env:t1", "project:env:p1"] });
    state.teams = [
      team(
        "t1",
        "Growth",
        members.map((m) => m.toLowerCase()),
      ),
    ];
    await screen.rerender(element());
    expect(rows(screen.container)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Growth" }));
    expect(state.update).toHaveBeenLastCalledWith({
      sidebarAssistantsCollapsedGroups: ["project:env:p1"],
    });
  });

  it("folds a project the same way", async () => {
    setup([{ name: "Revisor", scope: "project", projectId: "p1" }], { folded: ["project:env:p1"] });
    await using screen = await render(element());
    expect(rows(screen.container)).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "ProOps" }));
    expect(state.update).toHaveBeenCalledWith({ sidebarAssistantsCollapsedGroups: [] });
  });

  it("runs the group menu", async () => {
    setup(["Jarvis"]);
    state.teams = [team("t1", "Growth", ["jarvis"])];
    await using screen = await render(element());
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit group" }));
    expect(state.openTeamDialog).toHaveBeenCalledWith({ environmentId: "env", teamId: "t1" });
    await userEvent.click(screen.getByRole("button", { name: "Growth actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New assistant in this group" }));
    expect(state.openDialog).toHaveBeenCalledWith({
      environmentId: "env",
      preset: { teamId: "t1" },
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("starts an assistant inside a project from its menu", async () => {
    setup([{ name: "Revisor", scope: "project", projectId: "p1" }]);
    await using screen = await render(element());
    await userEvent.click(screen.getByRole("button", { name: "ProOps actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New assistant in this project" }));
    expect(state.openDialog).toHaveBeenCalledWith({
      environmentId: "env",
      preset: { projectId: "p1" },
    });
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
