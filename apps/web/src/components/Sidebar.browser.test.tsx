import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { Profiler, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useRouterState } from "@tanstack/react-router";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { selectActiveMainFileSurface, useRightPanelStore } from "../rightPanelStore";
import {
  readThreadShell,
  useProjects,
  useQuietThreadShells,
  useThreadShell,
} from "../state/entities";
import {
  useAssistantEntries,
  useAssistantLiveWork,
  useAssistantTasksByAssistant,
} from "../state/assistants";
import * as session from "../state/session";
import { setTaskDismissed, useAssistantTeamFlows } from "./assistants/useAssistantFlows";
import { THREAD_TAB_DROP_EVENT, type ThreadTabDropDetail } from "./chat/threadContextDrag";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow, StaticThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/assistants", { spy: true });
vi.mock("./assistants/useAssistantFlows", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
    { key: "mod+shift+[", command: "thread.previous" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const { routeThreadRef } = mockFiveThreadSidebar();
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(sidebarElement());
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });

  // regression: every sidebar update re-rendered all thread rows, twice: the rows were not memoized
  // and a new sortable id array rebuilt dnd-kit's context
  it("does not re-render thread rows when the sidebar re-renders with the same threads", async () => {
    const { threads } = mockFiveThreadSidebar();
    await using screen = await render(sidebarElement());
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();

    const beforeUpdate = rowRenders();
    vi.mocked(useQuietThreadShells).mockReturnValue([...threads]);
    await screen.rerender(sidebarElement());
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    expect(rowRenders() - beforeUpdate, "thread rows re-rendered with unchanged props").toBe(0);
  });
});

describe("sidebar thread pick", () => {
  it("lands on the thread's chat tab, even over a file tab it had showing", async () => {
    const activeProject = project("active");
    const threads = [threadShell(activeProject.id, 0), threadShell(activeProject.id, 1)];
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    const picked: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[1]!.id,
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    useRightPanelStore.getState().openFile(picked, "src/x.ts");
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByText("Thread 1").first());
    expect(
      selectActiveMainFileSurface(useRightPanelStore.getState().byThreadKey, picked),
    ).toBeNull();
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe(`/local/${threads[1]!.id}`),
    );
  });
});

interface AssistantSpec {
  readonly id: string;
  readonly archived?: boolean;
  readonly role?: string;
}

/**
 * Assistants, groups and their tasks as the state hooks return them, with live shells pushed per
 * thread key the way a stream updates them. The route follows the test router when `route` is
 * "router".
 */
function mockAssistantState(input: {
  readonly assistants: ReadonlyArray<AssistantSpec>;
  readonly teams?: ReadonlyArray<{ id: string; name: string; memberIds: string[] }>;
  readonly tasks?: ReadonlyArray<{
    readonly owner: string;
    readonly shell: EnvironmentThreadShell;
    readonly dismissed?: boolean;
  }>;
  readonly projectThreads?: ReadonlyArray<EnvironmentThreadShell>;
  /** Assistants whose task list starts open. */
  readonly expanded?: ReadonlyArray<string>;
  readonly route?: "router" | ScopedThreadRef | null;
}) {
  const environmentId = EnvironmentId.make("local");
  const activeProject = project("active");
  const entryOf = (spec: AssistantSpec) => ({
    environmentId,
    assistant: {
      id: spec.id,
      name: spec.id === "jarvis" ? "Jarvis" : `Assistant ${spec.id}`,
      handle: spec.id,
      role: spec.role ?? "",
      threadId: ThreadId.make(`assistant:${spec.id}:1`),
      scope: "all",
      projectId: activeProject.id,
      projectIds: [],
      isDefault: spec.id === "jarvis",
      avatar: null,
      icon: null,
      archivedAt: spec.archived ? "2026-01-02T00:00:00.000Z" : null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const active = input.assistants.filter((spec) => !spec.archived).map(entryOf);
  const archived = input.assistants.filter((spec) => spec.archived).map(entryOf);
  const teams = (input.teams ?? []).map((team) => ({
    environmentId,
    team: { ...team, chat: null, updatedAt: "2026-01-01T00:00:00.000Z" },
  }));
  const tasks = input.tasks ?? [];
  const live = new Map<string, EnvironmentThreadShell>(
    [...(input.projectThreads ?? []), ...tasks.map((task) => task.shell)].map((shell) => [
      shell.id,
      shell,
    ]),
  );
  let quiet: ReadonlyArray<EnvironmentThreadShell> = [...live.values()];
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const entries = { active, archived, teams, activeTeams: teams, environmentIds: [] };
  // As the state atom does, only active assistants list tasks.
  const tasksByAssistant = new Map(
    active.map(({ assistant }) => [
      `local:${assistant.id}`,
      tasks
        .filter((task) => task.owner === assistant.id)
        .map((task) => ({
          threadId: task.shell.id,
          assistantId: assistant.id,
          projectId: activeProject.id,
          title: task.shell.title,
          createdAt: "2026-01-01T00:00:00.000Z",
          dismissedAt: task.dismissed ? "2026-01-03T00:00:00.000Z" : null,
        })),
    ]),
  );
  const work = { sites: [], subagents: new Map(), taskThreadKeys: new Set<string>() };
  vi.mocked(useAssistantEntries).mockReturnValue(entries as never);
  vi.mocked(useAssistantTasksByAssistant).mockReturnValue(tasksByAssistant as never);
  vi.mocked(useAssistantLiveWork).mockReturnValue(work as never);
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockImplementation(() =>
    useSyncExternalStore(subscribe, () => quiet),
  );
  const shellCalls = new Map<string, number>();
  vi.mocked(useThreadShell).mockImplementation((ref) => {
    const id = ref?.threadId ?? "";
    shellCalls.set(id, (shellCalls.get(id) ?? 0) + 1);
    return useSyncExternalStore(subscribe, () => live.get(id) ?? null);
  });
  const route = input.route ?? null;
  if (route === "router") {
    vi.mocked(useThreadRouteTarget).mockImplementation(() => {
      const path = useRouterState({ select: (state) => state.location.pathname });
      const match = /^\/([^/]+)\/([^/]+)$/.exec(decodeURIComponent(path));
      return {
        kind: "server",
        threadRef:
          match === null
            ? null
            : { environmentId: EnvironmentId.make(match[1]!), threadId: ThreadId.make(match[2]!) },
      } as never;
    });
  } else {
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: route } as never);
  }
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId, projectId: activeProject.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: route === "router" ? null : route,
  });
  useUiStateStore.setState({
    projectExpandedById: Object.fromEntries(
      (input.expanded ?? []).map((id) => [`assistant:local:${id}`, true]),
    ),
  });
  return {
    shellCalls,
    /** A streaming tick: the live shell moves, the quiet list holds still. */
    push: (shell: EnvironmentThreadShell) => {
      live.set(shell.id, shell);
      notify();
    },
    /** A change the quiet list sees too, such as a run ending. */
    settle: (shell: EnvironmentThreadShell) => {
      live.set(shell.id, shell);
      quiet = quiet.map((candidate) => (candidate.id === shell.id ? shell : candidate));
      notify();
    },
    [Symbol.dispose]: () => {
      for (const mock of [
        useThreadShell,
        useQuietThreadShells,
        useAssistantEntries,
        useAssistantTasksByAssistant,
        useAssistantLiveWork,
        useThreadRouteTarget,
      ] as const) {
        vi.mocked(mock).mockReset();
      }
      useUiStateStore.setState({ projectExpandedById: {} });
    },
  };
}

const ROUTE_REVEAL = { observedKey: null, pendingKey: null };
const taskShell = (index: number, status: "running" | "completed" = "running", tick = 0) => ({
  ...makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`task-${index}`),
    projectId: ProjectId.make("active"),
    title: `Task ${index}`,
    runtime: { status, activeRunId: status === "running" ? "run-1" : null } as never,
  }),
  updatedAt: `2026-01-01T00:00:${String(tick % 60).padStart(2, "0")}.000Z`,
});

/** Jarvis with one task in the project "active", beside one thread of the user's own. */
const jarvisWithTask = (
  options: {
    readonly state?: "running" | "completed";
    readonly route?: ScopedThreadRef | null;
  } = {},
) =>
  mockAssistantState({
    assistants: [{ id: "jarvis" }],
    tasks: [{ owner: "jarvis", shell: taskShell(1, options.state) }],
    projectThreads: [threadShell(ProjectId.make("active"), 0)],
    expanded: ["jarvis"],
    route: options.route ?? null,
  });

const sidebarElement = () => (
  <SidebarProvider>
    <Sidebar routeReveal={ROUTE_REVEAL} />
  </SidebarProvider>
);
const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

function mockFiveThreadSidebar() {
  const activeProject = project("active");
  const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
  const routeThreadRef: ScopedThreadRef = {
    environmentId: activeProject.environmentId,
    threadId: threads[0]!.id,
  };
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: {
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
    },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
  return { threads, routeThreadRef };
}

const TASK_COPY = "assistant:local:jarvis/local:task-1";

describe("sidebar teams zone", () => {
  it("numbers Teams rows before the projects' and lists an assistant's task in both", async () => {
    using _state = jarvisWithTask();
    await using screen = await render(sidebarElement());
    await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector(`[data-sidebar-row="${TASK_COPY}"]`),
    );
    expect(copy.getAttribute("data-sidebar-parent")).toBe("assistant:local:jarvis");
    // A task is a project thread too, whoever launched it.
    expect(screen.container.querySelectorAll('[data-sidebar-row="local:task-1"]')).toHaveLength(1);

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    const hints = () =>
      [...screen.container.querySelectorAll("[data-jump-hint]")].map((hint) =>
        hint.closest("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
      );
    // The assistant's chat and its task, then the same task in its project.
    expect(hints()).toEqual(["assistant:local:jarvis", TASK_COPY, "local:task-1"]);
    // One number per thread: the task's two rows share the number Teams gave it.
    const labels = [...screen.container.querySelectorAll("[data-jump-hint]")].map(
      (hint) => hint.textContent,
    );
    expect(labels[2]).toBe(labels[1]);
    expect(labels[1]).not.toBe(labels[0]);
    await userEvent.keyboard(`{/${modifier}}`);
    await userEvent.keyboard(`{${modifier}>}1{/${modifier}}`);
    await vi.waitFor(() =>
      expect(decodeURIComponent(screen.router?.state.location.pathname ?? "")).toBe(
        "/local/assistant:jarvis:1",
      ),
    );
  });

  it.each([
    { archived: false, dismissed: false, listedUnderAssistant: true },
    { archived: true, dismissed: false, listedUnderAssistant: false },
    { archived: false, dismissed: true, listedUnderAssistant: false },
  ])(
    "an assistant archived=$archived keeps its task dismissed=$dismissed in the project list, under it: $listedUnderAssistant",
    async ({ archived, dismissed, listedUnderAssistant }) => {
      using _state = mockAssistantState({
        assistants: [{ id: "jarvis" }, { id: "nova", archived }],
        tasks: [{ owner: "nova", shell: taskShell(1), dismissed }],
        projectThreads: [threadShell(ProjectId.make("active"), 0)],
        expanded: ["nova"],
      });
      await using screen = await render(sidebarElement());
      await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(screen.container.querySelectorAll('[data-thread-item="local:task-1"]').length).toBe(
          1,
        ),
      );
      expect(
        screen.container.querySelectorAll('[data-sidebar-row="assistant:local:nova/local:task-1"]'),
      ).toHaveLength(listedUnderAssistant ? 1 : 0);
      // The Agents section is gone; Teams and Projects are the only lists.
      expect(screen.container.querySelector('[data-sidebar-row="section:agents"]')).toBeNull();
      expect(screen.container.textContent).not.toContain("Agents");
    },
  );

  it("keeps a clicked task row still while its thread opens", async () => {
    using _state = mockAssistantState({
      assistants: [{ id: "jarvis" }],
      tasks: [{ owner: "jarvis", shell: taskShell(1) }],
      // Pinned, so they list above where the project would list the task, far off-screen.
      projectThreads: Array.from({ length: 60 }, (_, index) => ({
        ...threadShell(ProjectId.make("active"), index),
        pinnedAt: "2026-01-01T00:00:00.000Z",
        pinOrderKey: `a${String(index).padStart(2, "0")}`,
      })),
      expanded: ["jarvis"],
      route: "router",
    });
    await using screen = await render(sidebarElement());
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${TASK_COPY}"]`),
    );
    const top = copy.getBoundingClientRect().top;
    await userEvent.click(copy);
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/task-1"));
    // The route reached the sidebar once the row shows as current.
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector(`[data-sidebar-row="${TASK_COPY}"]`)
          ?.getAttribute("aria-current"),
      ).toBe("page"),
    );
    const after = screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${TASK_COPY}"]`)!;
    expect(after.getBoundingClientRect().top).toBe(top);
  });

  it("offers Dismiss in a finished task's action slot instead of Settle", async () => {
    using _state = jarvisWithTask({ state: "completed" });
    vi.mocked(setTaskDismissed).mockResolvedValue(undefined);
    await using screen = await render(sidebarElement());
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${TASK_COPY}"]`),
    );
    expect(copy.querySelector('[aria-label="Settle thread"]')).toBeNull();
    copy.querySelector<HTMLElement>('[aria-label="Dismiss task"]')!.click();
    expect(setTaskDismissed).toHaveBeenCalledWith("local", "task-1", true);
  });

  it("walks to the previous thread through the Teams zone, as ⌘1–9 numbers it", async () => {
    using _state = jarvisWithTask({
      route: { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("task-1") },
    });
    await using screen = await render(sidebarElement());
    await vi.waitUntil(() =>
      screen.container.querySelector('[data-sidebar-row="assistant:local:jarvis"]'),
    );
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}{Shift>}[[{/Shift}{/${modifier}}`);
    await vi.waitFor(() =>
      expect(decodeURIComponent(screen.router?.state.location.pathname ?? "")).toBe(
        "/local/assistant:jarvis:1",
      ),
    );
  });

  it("renames a task in place on its row under the assistant", async () => {
    using _state = jarvisWithTask();
    using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
    using _liveScope = vi.spyOn(session, "useEnvironmentScope").mockReturnValue(true);
    await using screen = await render(sidebarElement());
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${TASK_COPY}"]`),
    );
    await userEvent.dblClick(copy);
    const inputs = () =>
      [...screen.container.querySelectorAll('input[aria-label="Thread title"]')].map((input) =>
        input.closest("li")?.querySelector("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
      );
    await vi.waitFor(() => expect(inputs()).toEqual([TASK_COPY]));
  });

  it("drags a task row into a split of its project", async () => {
    using _state = jarvisWithTask();
    vi.mocked(readThreadShell).mockReturnValue(taskShell(1));
    await using screen = await render(sidebarElement());
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector(`[data-sidebar-row="${TASK_COPY}"]`),
    );
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
    copy.dispatchEvent(pointer("pointerdown", 1, 1));
    const pane = document.createElement("div");
    pane.setAttribute("data-thread-groups", "local:active");
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
    expect(drops.map((drop) => drop.threadKey)).toEqual(["local:task-1"]);
  });
});

describe("sidebar teams render cost", () => {
  it("re-renders only the rows of a streaming task, with 37 assistants in 7 groups", async () => {
    const owners = [1, 5, 9, 13, 17];
    using state = mockAssistantState({
      assistants: Array.from({ length: 37 }, (_, index) => ({
        id: `a${index}`,
        role: index % 3 === 0 ? "Engineer" : "",
      })),
      // Five members each; the last of each group also sits in the next one.
      teams: Array.from({ length: 7 }, (_, index) => ({
        id: `g${index}`,
        name: `Group ${index}`,
        memberIds: [0, 1, 2, 3, 4].map((offset) => `a${(index * 4 + offset) % 37}`),
      })),
      tasks: owners.map((owner, index) => ({ owner: `a${owner}`, shell: taskShell(index) })),
      expanded: owners.map((owner) => `a${owner}`),
    });
    const previousSettings = getClientSettings();
    using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(previousSettings) };
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAssistantsExpandedGroups: Array.from(
        { length: 7 },
        (_, index) => `group:local:g${index}`,
      ),
      sidebarAssistantsShowAll: true,
    });
    let commits = 0;
    await using screen = await render(
      <Profiler id="sidebar" onRender={() => (commits += 1)}>
        {sidebarElement()}
      </Profiler>,
    );
    await vi.waitUntil(() =>
      screen.container.querySelector('[data-sidebar-row="assistant:local:a36"]'),
    );
    const ownerChat = (id: string) => owners.some((owner) => id === `assistant:a${owner}:1`);
    const chatRenders = (filter: (id: string) => boolean) =>
      [...state.shellCalls]
        .filter(([id]) => id.startsWith("assistant:") && filter(id))
        .reduce((sum, [, count]) => sum + count, 0);
    const snapshot = () => ({
      commits,
      assistantRows: chatRenders(() => true),
      unrelatedAssistantRows: chatRenders((id) => !ownerChat(id)),
      folderRows: vi.mocked(useAssistantTeamFlows).mock.calls.length,
      taskRows: vi.mocked(StaticThreadRow).mock.calls.length,
      projectRows: vi.mocked(SortableThreadRow).mock.calls.length,
    });
    const delta = (from: ReturnType<typeof snapshot>) =>
      Object.fromEntries(
        Object.entries(snapshot()).map(([key, value]) => [
          key,
          value - from[key as keyof typeof from],
        ]),
      ) as ReturnType<typeof snapshot>;
    const UPDATES = 50;
    // A first push flushes whatever the mount left pending, so the count starts from rest.
    await act(() => state.push(taskShell(0, "running", 0)));
    const mounted = snapshot();
    for (let tick = 0; tick < UPDATES; tick += 1) {
      await act(() => state.push(taskShell(tick % 5, "running", tick + 1)));
    }
    const streamed = delta(mounted);
    const beforeSettle = snapshot();
    await act(() => state.settle(taskShell(0, "completed", 59)));
    const settled = delta(beforeSettle);
    console.info("teams render cost", JSON.stringify({ UPDATES, streamed, settled }));
    expect(streamed.unrelatedAssistantRows).toBe(0);
    expect(streamed.folderRows).toBe(0);
    expect(streamed.taskRows).toBeLessThanOrEqual(UPDATES);
    expect(streamed.assistantRows).toBe(0);
    expect(streamed.commits).toBeLessThanOrEqual(UPDATES);
    expect(settled.unrelatedAssistantRows).toBe(0);
    expect(settled.folderRows).toBe(0);
  });
});
