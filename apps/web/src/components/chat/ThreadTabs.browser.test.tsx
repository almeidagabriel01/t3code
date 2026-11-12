import type { ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { act, render } from "../../../test/render";
import { type ThreadTabWorkspace, useThreadTabsStore } from "../../threadTabsStore";
import { ThreadContextDragGhost } from "./ThreadContextDragGhost";
import { useThreadTabsLayout } from "./ThreadTabs";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
  threadContextDropTargetProps,
} from "./threadContextDrag";

const state = vi.hoisted(() => ({ deleted: new Set<string>() }));

vi.mock("../ChatView", () => ({
  default: (props: { threadId: string }) => (
    <div data-testid="embedded-chat">
      <textarea aria-label={`Composer ${props.threadId}`} />
    </div>
  ),
}));
vi.mock("../../state/entities", () => {
  const shell = (ref: { environmentId: string; threadId: string } | null) =>
    ref === null
      ? null
      : {
          id: ref.threadId,
          environmentId: ref.environmentId,
          projectId: "p",
          title: `Thread ${ref.threadId}`,
          lineage: { sideChat: false },
          deletedAt: state.deleted.has(ref.threadId) ? "2026-11-11T00:00:00Z" : null,
        };
  return { useQuietThreadShell: shell, readThreadShell: shell };
});

const PROJECT = "env:p";
const ref = (threadId: string) =>
  ({ environmentId: "env", threadId }) as unknown as ScopedThreadRef;
const leaf = (groupId: string) => ({ type: "leaf", groupId }) as const;

async function setup(workspace?: ThreadTabWorkspace, options: { deleted?: string[] } = {}) {
  // The default 414px viewport would put the side-by-side layout and its drop points off screen.
  await page.viewport(1280, 800);
  state.deleted = new Set(options.deleted);
  useThreadTabsStore.setState({ byProject: workspace ? { [PROJECT]: workspace } : {} });
}
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
function Harness(props: { route: string; width?: number }) {
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
          {tabs.routeStrip}
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

    // The composer takes a sidebar drop as a mention; another project's thread finds no zone.
    await act(() => moveThreadContextDrag(center(screen.getByTestId("composer").element()), label));
    expect(preview()).toBeNull();
    await act(() => moveThreadContextDrag(rightEdge, { ...label, projectKey: "env:other" }));
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
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/env/x"));
    expect(dropThreadContext({ x: 5000, y: 5000 }, [ref("x")], label)).toBe(false);
    expect(dropThreadContext(rightEdge, [ref("x"), ref("y")], label)).toBe(false);
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
});
