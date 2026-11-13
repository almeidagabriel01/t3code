import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { selectActiveMainFileSurface, useRightPanelStore } from "../rightPanelStore";
import { readThreadShell, useProjects, useQuietThreadShells } from "../state/entities";
import * as session from "../state/session";
import { THREAD_TAB_DROP_EVENT, type ThreadTabDropDetail } from "./chat/threadContextDrag";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow, StaticThreadRow } from "./sidebar/SidebarThreadRow";
import {
  type AssistantSidebarModel,
  useAssistantSidebarModel,
} from "./assistants/useAssistantSidebarModel";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("./assistants/useAssistantSidebarModel", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
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
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

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

/** One assistant whose task is also its project's thread, so the sidebar draws it twice. */
function mockTaskCopy() {
  const activeProject = project("active");
  const task = threadShell(activeProject.id, 1);
  const environmentId = activeProject.environmentId;
  const entry = {
    environmentId,
    assistant: { id: "jarvis", name: "Jarvis", threadId: null, role: "", scope: "all" },
  } as never as AssistantSidebarModel["active"][number];
  vi.mocked(useAssistantSidebarModel).mockReturnValue({
    enabled: true,
    collapsed: false,
    showAll: false,
    expandedGroups: [],
    active: [entry],
    teams: [],
    ranked: [],
    shown: [{ entry, presence: { mood: "idle" } }],
    hidden: 0,
    items: new Map([
      [
        "local:jarvis",
        {
          sections: {
            pinned: [],
            open: [{ task: { threadId: task.id }, shell: task, state: "running" }],
            snoozed: [],
            settled: [],
          },
          expanded: true,
          subagents: [],
        },
      ],
    ]),
    threadKeys: [],
  } as never as AssistantSidebarModel);
  vi.mocked(useProjects).mockReturnValue([activeProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue([task]);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: null } as never);
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId, projectId: activeProject.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: null,
  });
  return task;
}

const sidebarElement = () => (
  <SidebarProvider>
    <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
  </SidebarProvider>
);

describe("sidebar assistants section", () => {
  it("numbers its rows before the projects' and draws a task as a second, unsortable row", async () => {
    const activeProject = project("active");
    const threads = [threadShell(activeProject.id, 0), threadShell(activeProject.id, 1)];
    const task = threads[1]!;
    const environmentId = activeProject.environmentId;
    const entry = {
      environmentId,
      assistant: {
        id: "jarvis",
        name: "Jarvis",
        handle: "jarvis",
        threadId: ThreadId.make("assistant:jarvis:1"),
        role: "",
        scope: "all",
        projectId: "p0",
        avatar: null,
        icon: null,
      },
    } as never as AssistantSidebarModel["active"][number];
    vi.mocked(useAssistantSidebarModel).mockReturnValue({
      enabled: true,
      collapsed: false,
      showAll: false,
      expandedGroups: [],
      active: [entry],
      teams: [],
      ranked: [],
      shown: [{ entry, presence: { mood: "idle" } }],
      hidden: 0,
      items: new Map([
        [
          "local:jarvis",
          {
            sections: {
              pinned: [],
              open: [{ task: { threadId: task.id }, shell: task, state: "running" }],
              snoozed: [],
              settled: [],
            },
            expanded: true,
            subagents: [],
          },
        ],
      ]),
      threadKeys: ["local:assistant:jarvis:1", `local:${task.id}`],
    } as never as AssistantSidebarModel);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: null } as never);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId, projectId: activeProject.id },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 0").first()).toBeInTheDocument();
    const copy = screen.container.querySelector(
      `[data-sidebar-row="assistant:local:jarvis/local:${task.id}"]`,
    );
    expect(copy?.getAttribute("data-sidebar-parent")).toBe("assistant:local:jarvis");
    // The list's geometry reads only the project's own row of the thread.
    expect(screen.container.querySelectorAll(`[data-thread-item="local:${task.id}"]`)).toHaveLength(
      1,
    );

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const before = vi.mocked(StaticThreadRow).mock.calls.length;
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    const hints = () =>
      [...screen.container.querySelectorAll("[data-jump-hint]")].map((hint) =>
        hint.closest("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
      );
    // Two shortcuts: the assistant's chat, then its task, on both rows of the task.
    expect(hints().toSorted()).toEqual(
      [
        "assistant:local:jarvis",
        `assistant:local:jarvis/local:${task.id}`,
        `local:${task.id}`,
      ].toSorted(),
    );
    expect(vi.mocked(StaticThreadRow).mock.calls.length).toBeGreaterThan(before);
    await userEvent.keyboard(`{/${modifier}}`);
    await userEvent.keyboard(`{${modifier}>}1{/${modifier}}`);
    await vi.waitFor(() =>
      expect(decodeURIComponent(screen.router?.state.location.pathname ?? "")).toBe(
        "/local/assistant:jarvis:1",
      ),
    );
  });

  it("renames a task in place on the row acted on, not on its project's row", async () => {
    const task = mockTaskCopy();
    using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(true);
    using _liveScope = vi.spyOn(session, "useEnvironmentScope").mockReturnValue(true);
    await using screen = await render(sidebarElement());
    const copyKey = `assistant:local:jarvis/local:${task.id}`;
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${copyKey}"]`),
    );
    await userEvent.dblClick(copy);
    const inputs = () =>
      [...screen.container.querySelectorAll('input[aria-label="Thread title"]')].map((input) =>
        input.closest("li")?.querySelector("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
      );
    await vi.waitFor(() => expect(inputs()).toEqual([copyKey]));
  });

  it("drags a task's second row into a split of its project", async () => {
    const task = mockTaskCopy();
    vi.mocked(readThreadShell).mockReturnValue(task);
    await using screen = await render(sidebarElement());
    const copy = await vi.waitUntil(() =>
      screen.container.querySelector(
        `[data-sidebar-row="assistant:local:jarvis/local:${task.id}"]`,
      ),
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
    expect(drops.map((drop) => drop.threadKey)).toEqual([`local:${task.id}`]);
  });
});
