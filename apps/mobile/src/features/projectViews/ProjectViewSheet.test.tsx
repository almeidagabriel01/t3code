import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    project: { id: "p1", title: "Alpha" } as unknown,
    boards: ["env"] as string[],
    dispatch: vi.fn(),
    goBack: vi.fn(),
  },
}));

vi.mock("react-native", () => ({ View: Children, ScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: mocks.dispatch, goBack: mocks.goBack }),
  StackActions: { replace: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Children }));
vi.mock("../../components/ui/SheetHeader", () => ({
  SheetHeader: (props: {
    title: string;
    onClose: () => void;
    actions?: { accessibilityLabel: string; onPress: () => void }[];
  }) => (
    <>
      <button aria-label={`Close ${props.title}`} onClick={props.onClose} />
      {props.actions?.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          onClick={action.onPress}
        />
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/SegmentedControl", () => ({
  SegmentedControl: (props: {
    options: { value: string; label: string; icon?: string }[];
    selected: string;
    onSelect: (value: string) => void;
  }) =>
    props.options.map((option) => (
      <button
        key={option.value}
        aria-selected={option.value === props.selected}
        data-icon={option.icon}
        onClick={() => props.onSelect(option.value)}
      >
        {option.label}
      </button>
    )),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { threadId: string }) => ({ id: ref.threadId, projectId: "p1" }),
  useProject: (ref: { projectId: string } | null) => (ref === null ? null : mocks.project),
}));
vi.mock("../../state/kanban", () => ({ useKanbanEnvironmentIds: () => mocks.boards }));
vi.mock("../kanban/ProjectBoardView", () => ({
  ProjectBoardView: (props: { projectId: string }) => `board:${props.projectId}`,
}));
vi.mock("../settings/ProjectScheduledTasksView", () => ({
  ProjectScheduledTasksView: (props: { projectId: string }) => `scheduled:${props.projectId}`,
}));
vi.mock("../settings/components/HeavyQueueSection", () => ({
  HeavyCommandsSection: (props: { projectId: string }) => `commands:${props.projectId}`,
  HeavyQueueSection: (props: { projectId: string }) => `queue:${props.projectId}`,
}));
vi.mock("./ProjectActivityView", () => ({
  ProjectActivityView: (props: { projectId: string; onOpenThread: (id: string) => void }) => (
    <button onClick={() => props.onOpenThread("t9")}>{`activity:${props.projectId}`}</button>
  ),
}));
vi.mock("./ProjectMemoryView", () => ({
  ProjectMemoryView: (props: { projectId: string }) => `memory:${props.projectId}`,
}));

import { ProjectViewSheet } from "./ProjectViewSheet";

async function mount(view?: string) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const route = {
    params: { environmentId: "env", threadId: "t1", ...(view === undefined ? {} : { view }) },
  };
  await act(async () => root.render(<ProjectViewSheet route={route as never} />));
  const tabs = () =>
    [...host.querySelectorAll("button[aria-selected]")].map((b) => [
      b.textContent,
      b.getAttribute("data-icon"),
    ]);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === text || b.getAttribute("aria-label") === text,
    )!;
  return { host, button, tabs, unmount: () => act(() => root.unmount()) };
}

afterEach(() => {
  mocks.project = { id: "p1", title: "Alpha" };
  mocks.boards = ["env"];
  vi.clearAllMocks();
});

describe("ProjectViewSheet", () => {
  it("opens on the linked view, switches views, and closes", async () => {
    const view = await mount("memory");
    expect(view.host.textContent).toContain("memory:p1");
    expect(view.button("Memory").getAttribute("aria-selected")).toBe("true");
    act(() => view.button("Heavy work").click());
    expect(view.host.textContent).toContain("commands:p1queue:p1");
    act(() => view.button("Close Alpha").click());
    expect(mocks.goBack).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("has five sections with icons, opening on the board, with Manage only on Scheduled", async () => {
    const view = await mount();
    expect(view.tabs()).toEqual([
      ["Board", "square.grid.2x2"],
      ["Scheduled", "calendar.badge.clock"],
      ["Activity", "bell.badge"],
      ["Memory", "brain"],
      ["Heavy work", "hourglass"],
    ]);
    expect(view.host.textContent).toContain("board:p1");
    expect(view.button("Manage scheduled tasks")).toBeUndefined();
    act(() => view.button("Scheduled").click());
    expect(view.host.textContent).toContain("scheduled:p1");
    act(() => view.button("Manage scheduled tasks").click());
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "SettingsScheduledTasks",
      params: undefined,
    });
    await view.unmount();
  });

  it("drops Board where the server has no boards and falls back to the first section", async () => {
    mocks.boards = [];
    const view = await mount("board");
    expect(view.tabs().map(([label]) => label)).toEqual([
      "Scheduled",
      "Activity",
      "Memory",
      "Heavy work",
    ]);
    expect(view.host.textContent).toContain("scheduled:p1");
    await view.unmount();
  });

  it("opens a thread from Activity in place of the sheet", async () => {
    const view = await mount("activity");
    act(() => view.button("activity:p1").click());
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "t9" },
    });
    await view.unmount();
  });

  it("says so when the thread's project is gone", async () => {
    mocks.project = null;
    const view = await mount("activity");
    expect(view.host.textContent).toContain("Project not found");
    expect(view.button("Close Project")).toBeDefined();
    await view.unmount();
  });
});
