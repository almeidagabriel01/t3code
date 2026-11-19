import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { act, render } from "../../../test/render";
import { useClosedViewStore } from "../../closedViewStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { type ThreadTabWorkspace, useThreadTabsStore } from "../../threadTabsStore";
import { ThreadContextDragGhost } from "./ThreadContextDragGhost";
import { useThreadTabsLayout } from "./ThreadTabs";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropTargetProps,
} from "./threadContextDrag";

const state = vi.hoisted(() => ({
  deleted: new Set<string>(),
  working: new Set<string>(),
  // Threads of another project, by thread id; the rest are project "p".
  projects: new Map<string, string>(),
}));

vi.mock("../ChatView", () => ({
  default: (props: {
    threadId: string;
    renderGroupTabStrip?: (pendingFileIds: ReadonlySet<string>) => ReactNode;
  }) => (
    <div data-testid="embedded-chat">
      {props.renderGroupTabStrip?.(new Set())}
      <textarea aria-label={`Composer ${props.threadId}`} />
    </div>
  ),
}));
vi.mock("../../state/decisions", () => ({ useOpenDecisionThreadKeys: () => new Set<string>() }));
vi.mock("../../keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../keybindings")>()),
  resolveShortcutCommand: (event: KeyboardEvent) =>
    event.key === "w" && event.metaKey ? "rightPanel.close" : null,
}));
vi.mock("../../state/entities", () => {
  const shell = (ref: { environmentId: string; threadId: string } | null) =>
    ref === null
      ? null
      : {
          id: ref.threadId,
          environmentId: ref.environmentId,
          projectId: state.projects.get(ref.threadId) ?? "p",
          title: `Thread ${ref.threadId}`,
          lineage: { sideChat: false },
          deletedAt: state.deleted.has(ref.threadId) ? "2026-11-11T00:00:00Z" : null,
          runtime: state.working.has(ref.threadId) ? { status: "running" } : null,
          latestRun: null,
        };
  return {
    useQuietThreadShell: shell,
    readThreadShell: shell,
    useProject: (ref: { projectId: string } | null) =>
      ref === null ? null : { title: `Project ${ref.projectId}`, isScratch: false },
  };
});

const PROJECT = "env:p";
const ref = (threadId: string) =>
  ({ environmentId: "env", threadId }) as unknown as ScopedThreadRef;
const leaf = (groupId: string) => ({ type: "leaf", groupId }) as const;

async function setup(
  workspace?: ThreadTabWorkspace,
  options: { deleted?: string[]; working?: string[]; projects?: Record<string, string> } = {},
) {
  // The default 414px viewport would put the side-by-side layout and its drop points off screen.
  await page.viewport(1280, 800);
  state.deleted = new Set(options.deleted);
  state.working = new Set(options.working);
  state.projects = new Map(Object.entries(options.projects ?? {}));
  useThreadTabsStore.setState({
    byProject: workspace ? { [PROJECT]: workspace } : {},
    visibleKey: null,
  });
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    panelOpen: false,
  });
  useClosedViewStore.setState({ entries: [] });
}
const panels = () => useRightPanelStore.getState();
const tabNames = (screen: { getByRole: (role: "tablist") => { element: () => Element } }) =>
  [...screen.getByRole("tablist").element().querySelectorAll('[role="tab"]')].map((tab) =>
    tab.getAttribute("aria-label"),
  );
const workspace = () => useThreadTabsStore.getState().byProject[PROJECT];
const ratio = () => (workspace()?.layout as { ratio?: number } | undefined)?.ratio;
const sideBySide = (): ThreadTabWorkspace => ({
  groups: [
    { id: "main", tabs: ["env:a", "env:b"], active: "env:a" },
    { id: "g2", tabs: ["env:c"], active: "env:c" },
  ],
  layout: {
    type: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.5,
    first: leaf("main"),
    second: leaf("g2"),
  },
  focusedGroupId: "main",
});

/** The routed ChatView's shape: an area holding the chat column, its header, then the strip. */
function Harness(props: { route: string; width?: number; pending?: ReadonlySet<string> }) {
  const tabs = useThreadTabsLayout({ routeThreadRef: ref(props.route), enabled: true });
  return (
    <div style={{ display: "flex", width: props.width ?? 1000, height: 500 }}>
      <div {...tabs.containerProps} className="relative flex min-h-0 min-w-0 flex-1">
        <div
          data-chat-column
          data-testid="route-column"
          {...tabs.columnProps}
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${tabs.columnClassName ?? ""}`}
        >
          <header data-testid="route-header" data-top={String(tabs.routeEdges.top)}>
            Route {props.route}
          </header>
          {tabs.routeStrip?.(props.pending ?? new Set())}
          <div className="flex-1" />
          <div {...threadContextDropTargetProps()} data-testid="composer" style={{ height: 60 }} />
          <button type="button" onClick={() => tabs.closeRouteTab()}>
            Cmd+W
          </button>
        </div>
        {tabs.groups}
      </div>
    </div>
  );
}

describe("thread tabs", () => {
  it("opens the routed thread as a tab and switches tabs from the strip", async () => {
    await setup();
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    await vi.waitFor(() => expect(workspace()?.groups[0]?.tabs).toEqual(["env:a"]));
    await screen.rerender(<Harness route="b" />);
    await vi.waitFor(() => expect(workspace()?.groups[0]?.tabs).toEqual(["env:a", "env:b"]));

    await userEvent.click(screen.getByRole("tab", { name: "Thread a" }));
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/a"));
  });

  it("closes tabs with the x, a middle click and the close shortcut", async () => {
    await setup({
      ...sideBySide(),
      groups: [{ id: "main", tabs: ["env:a", "env:b", "env:c"], active: "env:a" }],
      layout: leaf("main"),
    });
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });

    await userEvent.click(screen.getByRole("button", { name: "Close Thread c" }));
    expect(workspace()?.groups[0]?.tabs).toEqual(["env:a", "env:b"]);
    expect(useClosedViewStore.getState().entries[0]).toMatchObject({
      kind: "thread-tab",
      threadRef: ref("c"),
    });
    await act(() => {
      screen
        .getByRole("tab", { name: "Thread b" })
        .element()
        .dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(workspace()?.groups[0]?.tabs).toEqual(["env:a"]);

    await userEvent.click(screen.getByRole("button", { name: "Cmd+W" }));
    expect(workspace()).toBeUndefined();
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/"));
  });

  it("puts each thread's files beside it in one row, the thread tab being its chat", async () => {
    await setup(
      {
        ...sideBySide(),
        groups: [{ id: "main", tabs: ["env:a", "env:b"], active: "env:a" }],
        layout: leaf("main"),
      },
      { working: ["b"] },
    );
    panels().openFile(ref("b"), "b.ts");
    panels().openFile(ref("a"), "src/x.ts");
    await using screen = await render(<Harness route="a" pending={new Set(["file:src/x.ts"])} />, {
      router: "/env/a",
    });
    expect(tabNames(screen)).toEqual(["Thread a", "x.ts", "Thread b", "b.ts"]);
    const tab = (name: string) => screen.getByRole("tab", { name, exact: true });
    await expect.element(tab("x.ts")).toHaveAttribute("aria-selected", "true");
    await expect.element(tab("Thread a")).toHaveAttribute("aria-selected", "false");
    expect(
      tab("Thread b").element().querySelector('[data-testid="sidebar-notification-dot"]'),
    ).not.toBeNull();
    expect(
      tab("Thread a").element().querySelector('[data-testid="sidebar-notification-dot"]'),
    ).toBeNull();

    // The thread tab shows its chat even over its own file.
    await userEvent.click(tab("Thread a"));
    await expect.element(tab("Thread a")).toHaveAttribute("aria-selected", "true");
    expect(panels().byThreadKey["env:a"]?.activeMainId).toBeUndefined();

    // Another thread's file routes there with that file shown.
    await userEvent.click(tab("b.ts"));
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/b"));
    expect(panels().byThreadKey["env:b"]?.activeMainId).toBe("file:b.ts");

    await userEvent.click(screen.getByRole("button", { name: "Close x.ts" }));
    expect(tabNames(screen)).toEqual(["Thread a", "Thread b", "b.ts"]);
    expect(useClosedViewStore.getState().entries[0]).toMatchObject({ kind: "panel-tab" });
  });

  it("scrolls a strip that is out of room to show its active tab", async () => {
    await setup({
      groups: [{ id: "main", tabs: ["env:a", "env:b", "env:c"], active: "env:c" }],
      layout: leaf("main"),
      focusedGroupId: "main",
    });
    panels().openFile(ref("c"), "src/a-long-file-name-that-needs-room.ts");
    await using screen = await render(<Harness route="c" width={240} />, { router: "/env/c" });
    const strip = screen.getByRole("tablist").element();
    await vi.waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(0));
  });

  it("moves focus across thread and file tabs with the arrows, Home and End", async () => {
    await setup({
      ...sideBySide(),
      groups: [{ id: "main", tabs: ["env:a", "env:b"], active: "env:a" }],
      layout: leaf("main"),
    });
    panels().openFile(ref("b"), "b.ts");
    panels().openFile(ref("a"), "src/x.ts");
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    const focused = () => document.activeElement?.getAttribute("aria-label");
    await expect
      .element(screen.getByRole("tab", { name: "x.ts" }))
      .toHaveAttribute("tabindex", "0");
    screen.getByRole("tab", { name: "x.ts" }).element().focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("Thread b");
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("b.ts");
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("Thread a");
    await userEvent.keyboard("{ArrowLeft}");
    expect(focused()).toBe("b.ts");
    await userEvent.keyboard("{Home}");
    expect(focused()).toBe("Thread a");
    await userEvent.keyboard("{End}");
    expect(focused()).toBe("b.ts");

    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/b"));
    expect(panels().byThreadKey["env:b"]?.activeMainId).toBe("file:b.ts");

    // Enter on a tab's x closes it rather than opening the tab.
    screen.getByRole("button", { name: "Close Thread a" }).element().focus();
    await userEvent.keyboard("{Enter}");
    expect(workspace()?.groups[0]?.tabs).toEqual(["env:b"]);
  });

  it("shows the whole active tab in a narrow row", async () => {
    await setup({
      ...sideBySide(),
      groups: [{ id: "main", tabs: ["env:a", "env:b"], active: "env:a" }],
      layout: leaf("main"),
    });
    for (const name of ["one.ts", "two.ts", "three.ts", "four.ts", "Transcript.tsx"]) {
      panels().openFile(ref("a"), `src/${name}`);
    }
    await using screen = await render(<Harness route="a" width={420} />, { router: "/env/a" });
    const active = screen.getByRole("tab", { name: "Transcript.tsx" });
    await expect.element(active).toHaveAttribute("aria-selected", "true");
    const strip = screen.getByRole("tablist").element().getBoundingClientRect();
    const tab = active.element().getBoundingClientRect();
    expect(tab.left).toBeGreaterThanOrEqual(strip.left);
    expect(tab.right).toBeLessThanOrEqual(strip.right + 1);
  });

  it("closes a split group's shown file with Cmd+W before its thread", async () => {
    await setup(sideBySide());
    panels().openFile(ref("c"), "c.ts");
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    const composer = screen.getByRole("textbox", { name: "Composer c" });
    await expect.element(screen.getByRole("tab", { name: "c.ts" })).toBeVisible();
    await userEvent.click(composer);
    await userEvent.keyboard("{Meta>}w{/Meta}");
    expect(panels().byThreadKey["env:c"]?.surfaces ?? []).toEqual([]);
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a", "env:b"], ["env:c"]]);
    await userEvent.keyboard("{Meta>}w{/Meta}");
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a", "env:b"]]);
  });

  it("lays groups out side by side and resizes them from the divider", async () => {
    await setup(sideBySide());
    await using screen = await render(<Harness route="a" />);

    await expect.element(screen.getByTestId("embedded-chat")).toBeVisible();
    expect(screen.getByTestId("route-column").element().style.width).toBe("50%");
    const divider = screen.getByRole("separator", { name: "Resize tab groups" });
    await userEvent.click(divider);
    await userEvent.keyboard("{ArrowRight}");
    expect(ratio()).toBeCloseTo(0.55);
    await userEvent.dblClick(divider);
    expect(workspace()?.layout).toMatchObject({ ratio: 0.5 });

    const element = divider.element() as HTMLElement;
    const box = element.parentElement!.getBoundingClientRect();
    await act(() => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientX: box.left + 500,
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: box.left + 300 }),
      );
    });
    expect(Number.parseFloat(screen.getByTestId("route-column").element().style.width)).toBeCloseTo(
      30,
    );
    await act(() => {
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
    expect(ratio()).toBeCloseTo(0.3);
  });

  it("focuses a group on click and opens the next sidebar pick there", async () => {
    await setup(sideBySide());
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    await userEvent.click(screen.getByRole("textbox", { name: "Composer c" }));
    expect(workspace()?.focusedGroupId).toBe("g2");
    await screen.rerender(<Harness route="d" />);
    await vi.waitFor(() => expect(workspace()?.groups[1]?.tabs).toEqual(["env:c", "env:d"]));

    // A group's title makes its thread the full one.
    await userEvent.click(screen.getByRole("button", { name: "Thread a", exact: true }));
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/a"));
  });

  it("folds to the routed group when two groups cannot fit", async () => {
    await setup(sideBySide());
    await using screen = await render(<Harness route="a" width={500} />);
    await expect.element(screen.getByTestId("embedded-chat")).not.toBeInTheDocument();
    expect(screen.getByTestId("route-column").element().style.width).toBe("");
  });
});

describe("dragging threads onto the thread area", () => {
  const center = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  };
  const preview = () => document.querySelector<HTMLElement>("[data-thread-tab-drop-preview]");
  const label = { title: "Thread x", count: 1, threadKey: "env:x", projectKey: PROJECT };

  it("shows Orca's zones while held and splits on an edge drop", async () => {
    await setup();
    // A thread dropped in from outside opens on its chat, not a file it left shown.
    panels().openFile(ref("x"), "x.ts");
    await using screen = await render(
      <>
        <Harness route="a" />
        <ThreadContextDragGhost />
      </>,
      { router: "/env/a" },
    );
    await vi.waitFor(() => expect(workspace()).toBeDefined());
    const { rect } = center(screen.getByTestId("route-column").element());
    const rightEdge = { x: rect.right - 10, y: rect.top + rect.height / 2 };
    await act(() => moveThreadContextDrag(rightEdge, label));
    expect(preview()?.dataset.threadTabDropPreview).toBe("right");
    await act(() =>
      moveThreadContextDrag({ x: rect.left + 10, y: rect.top + rect.height / 2 }, label),
    );
    expect(preview()?.dataset.threadTabDropPreview).toBe("left");
    await act(() =>
      moveThreadContextDrag({ x: rect.left + rect.width / 2, y: rect.top + 200 }, label),
    );
    expect(preview()?.dataset.threadTabDropPreview).toBe("center");

    // The composer takes a sidebar drop as a mention; a thread without tabs finds no zone.
    await act(() => moveThreadContextDrag(center(screen.getByTestId("composer").element()), label));
    expect(preview()).toBeNull();
    // A sidebar thread splits down from the band just above the composer; a tab keeps the full body.
    const composerTop = screen.getByTestId("composer").element().getBoundingClientRect().top;
    const aboveComposer = { x: rect.left + rect.width / 2, y: composerTop - 5 };
    await act(() => moveThreadContextDrag(aboveComposer, label));
    expect(preview()?.dataset.threadTabDropPreview).toBe("down");
    const sidebarDown = preview()?.getBoundingClientRect().toJSON();
    const tabLabel = { ...label, fromTab: true };
    await act(() => moveThreadContextDrag(aboveComposer, tabLabel));
    expect(preview()?.dataset.threadTabDropPreview).toBe("center");
    await act(() => moveThreadContextDrag({ ...aboveComposer, y: rect.bottom - 5 }, tabLabel));
    expect(preview()?.getBoundingClientRect().toJSON()).toEqual(sidebarDown);
    await act(() => moveThreadContextDrag(rightEdge, { ...label, projectKey: null }));
    expect(preview()).toBeNull();
    await act(() => moveThreadContextDrag(rightEdge, { ...label, count: 2, threadKey: null }));
    expect(preview()).toBeNull();

    // Over the strip it shows where the tab goes.
    const strip = center(screen.getByRole("tablist").element());
    await act(() => moveThreadContextDrag(strip, label));
    expect(preview()?.dataset.threadTabDropPreview).toBe("insert");

    await act(() => {
      expect(dropThreadContext(rightEdge, [ref("x")], label)).toBe(true);
      endThreadContextDrag();
    });
    expect(preview()).toBeNull();
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a"], ["env:x"]]);
    expect(panels().byThreadKey["env:x"]?.activeMainId).toBeUndefined();
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/x"));
    expect(dropThreadContext({ x: 5000, y: 5000 }, [ref("x")], label)).toBe(false);
    expect(dropThreadContext(rightEdge, [ref("x"), ref("y")], label)).toBe(false);
  });

  it("mentions a sidebar thread dropped on the composer and splits below on the band above it", async () => {
    await setup();
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    await vi.waitFor(() => expect(workspace()).toBeDefined());
    const composer = screen.getByTestId("composer").element();
    const mentioned = vi.fn();
    composer.addEventListener(THREAD_CONTEXT_DROP_EVENT, (event) =>
      mentioned((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail),
    );
    const { rect } = center(screen.getByTestId("route-column").element());
    const composerRect = composer.getBoundingClientRect();
    await act(() => {
      expect(dropThreadContext(center(composer), [ref("x")], label)).toBe(true);
    });
    expect(mentioned).toHaveBeenCalledWith([ref("x")]);
    expect(workspace()?.groups).toHaveLength(1);

    const aboveComposer = { x: rect.left + rect.width / 2, y: composerRect.top - 5 };
    await act(() => {
      expect(dropThreadContext(aboveComposer, [ref("x")], label)).toBe(true);
    });
    expect(mentioned).toHaveBeenCalledTimes(1);
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a"], ["env:x"]]);
    expect(workspace()?.layout).toMatchObject({ type: "split", direction: "vertical" });
  });

  it("moves a tab into another group's strip, collapsing the group it left", async () => {
    await setup(sideBySide());
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    const before = screen.getByRole("tab", { name: "Thread b" }).element().getBoundingClientRect();
    const point = { x: before.left + 5, y: before.top + before.height / 2 };
    const tabLabel = { ...label, threadKey: "env:c", fromTab: true };
    await act(() => {
      expect(dropThreadContext(point, [ref("c")], tabLabel)).toBe(true);
    });
    expect(workspace()?.groups).toEqual([
      { id: "main", tabs: ["env:a", "env:c", "env:b"], active: "env:c" },
    ]);
  });

  it("splits with another project's thread, each group keeping its own thread and project", async () => {
    await setup(undefined, { projects: { x: "q", z: "q" } });
    panels().openFile(ref("x"), "x.ts");
    await using screen = await render(
      <>
        <Harness route="a" />
        <ThreadContextDragGhost />
      </>,
      { router: "/env/a" },
    );
    await vi.waitFor(() => expect(workspace()).toBeDefined());
    const { rect } = center(screen.getByTestId("route-column").element());
    const rightEdge = { x: rect.right - 10, y: rect.top + rect.height / 2 };
    const otherLabel = { ...label, projectKey: "env:q" };
    await act(() => moveThreadContextDrag(rightEdge, otherLabel));
    expect(preview()?.dataset.threadTabDropPreview).toBe("right");
    await act(() => {
      expect(dropThreadContext(rightEdge, [ref("x")], otherLabel)).toBe(true);
      endThreadContextDrag();
    });
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a"], ["env:x"]]);
    expect(useThreadTabsStore.getState().byProject["env:q"]).toBeUndefined();
    const pane = () => document.querySelector<HTMLElement>("[data-side-chat-pane]");
    await expect.element(page.getByRole("tab", { name: "x.ts" })).toBeVisible();
    expect(pane()?.textContent).toContain("Project q");
    expect(pane()?.querySelector('[role="tab"][aria-label="x.ts"]')).not.toBeNull();

    // Routed to it, the thread stays in the split it was dropped into, not its own project's tabs.
    await screen.rerender(
      <>
        <Harness route="x" />
        <ThreadContextDragGhost />
      </>,
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-thread-group]")).toHaveLength(2),
    );
    expect(pane()?.textContent).toContain("Project p");
    expect(pane()?.textContent).toContain("Thread a");
    expect(useThreadTabsStore.getState().byProject["env:q"]).toBeUndefined();
    expect(workspace()?.focusedGroupId).toBe(workspace()?.groups[1]?.id);

    // A project-q thread with no tab anywhere joins the split's q group, and the split stays.
    await screen.rerender(
      <>
        <Harness route="z" />
        <ThreadContextDragGhost />
      </>,
    );
    await vi.waitFor(() =>
      expect(workspace()?.groups.map((group) => group.tabs)).toEqual([
        ["env:a"],
        ["env:x", "env:z"],
      ]),
    );
    expect(document.querySelectorAll("[data-thread-group]")).toHaveLength(2);
    expect(useThreadTabsStore.getState().byProject["env:q"]).toBeUndefined();

    // Closing it hands the group back to the tab it showed before, and remembers where it was.
    const qGroup = workspace()?.groups[1]?.id;
    await userEvent.click(screen.getByRole("button", { name: "Cmd+W" }));
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/x"));
    expect(workspace()?.groups[1]).toMatchObject({ tabs: ["env:x"], active: "env:x" });
    expect(useClosedViewStore.getState().entries[0]).toMatchObject({
      kind: "thread-tab",
      threadRef: ref("z"),
      layoutKey: PROJECT,
      groupId: qGroup,
    });
  });

  it("opens a pick in the split a reload brought back, not in its own project's tabs", async () => {
    await setup(undefined, { projects: { c: "q", z: "q" } });
    localStorage.setItem(
      "t3code:thread-tabs:v1",
      JSON.stringify({
        state: { byProject: { [PROJECT]: sideBySide() }, visibleKey: PROJECT },
        version: 1,
      }),
    );
    await useThreadTabsStore.persist.rehydrate();
    expect(useThreadTabsStore.getState().visibleKey).toBe(PROJECT);
    await using _screen = await render(<Harness route="z" />, { router: "/env/z" });
    await vi.waitFor(() =>
      expect(workspace()?.groups.map((group) => group.tabs)).toEqual([
        ["env:a", "env:b"],
        ["env:c", "env:z"],
      ]),
    );
    expect(document.querySelectorAll("[data-thread-group]")).toHaveLength(2);
    expect(useThreadTabsStore.getState().byProject["env:q"]).toBeUndefined();
  });

  it("splits with a thread from another environment", async () => {
    await setup();
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    await vi.waitFor(() => expect(workspace()).toBeDefined());
    const { rect } = center(screen.getByTestId("route-column").element());
    const remote = { environmentId: "env2", threadId: "w" } as unknown as ScopedThreadRef;
    await act(() => {
      dropThreadContext({ x: rect.right - 10, y: rect.top + rect.height / 2 }, [remote], {
        projectKey: "env2:p",
      });
    });
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a"], ["env2:w"]]);
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env2/w"));
    expect(document.querySelector("[data-side-chat-pane]")?.textContent).toContain("Thread w");
  });

  it("restores a persisted split across projects, files staying with their thread", async () => {
    await setup(undefined, { projects: { c: "q" } });
    panels().openFile(ref("c"), "c.ts");
    localStorage.setItem(
      "t3code:thread-tabs:v1",
      JSON.stringify({ state: { byProject: { [PROJECT]: sideBySide() } }, version: 1 }),
    );
    await useThreadTabsStore.persist.rehydrate();
    await using screen = await render(<Harness route="c" />, { router: "/env/c" });
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-thread-group]")).toHaveLength(2),
    );
    const routeTabs = screen.getByTestId("route-column").element().querySelectorAll('[role="tab"]');
    expect([...routeTabs].map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Thread c",
      "c.ts",
    ]);
    const pane = document.querySelector<HTMLElement>("[data-side-chat-pane]");
    expect(pane?.textContent).toContain("Project p");
    expect(pane?.querySelector('[role="tab"][aria-label="c.ts"]')).toBeNull();
    expect(useThreadTabsStore.getState().byProject["env:q"]).toBeUndefined();
  });

  it("moves a tab out of the project it was open in when another project's split takes it", async () => {
    await setup(undefined, { projects: { x: "q" } });
    useThreadTabsStore.setState({
      byProject: {
        "env:q": {
          groups: [{ id: "main", tabs: ["env:x", "env:y"], active: "env:x" }],
          layout: leaf("main"),
          focusedGroupId: "main",
        },
      },
    });
    await using screen = await render(<Harness route="a" />, { router: "/env/a" });
    await vi.waitFor(() => expect(workspace()).toBeDefined());
    const { rect } = center(screen.getByTestId("route-column").element());
    await act(() => {
      dropThreadContext({ x: rect.left + 10, y: rect.top + rect.height / 2 }, [ref("x")], label);
    });
    expect(workspace()?.groups.map((group) => group.tabs)).toEqual([["env:a"], ["env:x"]]);
    expect(useThreadTabsStore.getState().byProject["env:q"]?.groups).toEqual([
      { id: "main", tabs: ["env:y"], active: "env:y" },
    ]);
  });
});
