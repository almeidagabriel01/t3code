import type { Assistant, ModelSelection, ScheduledTask } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    tasks: [] as unknown[],
    navigate: vi.fn(),
    start: vi.fn(),
    setEnabled: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <>
      {props.label} {props.description}
    </>
  ),
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    accessibilityLabel: string;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-09T10:00:00Z") }));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; disabled?: boolean; onPress: () => void }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    accessibilityLabel: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.accessibilityLabel}
      checked={props.value}
      onChange={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => ({}), setScheduledTaskEnabled: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.setEnabled }));
vi.mock("../settings/scheduled-task-editor-state", () => ({
  startScheduledTaskEditor: mocks.start,
}));

import { AssistantSchedulesSection } from "./AssistantSchedulesSection";

const task = (id: string, threadId: string | null, enabled = true) =>
  ({
    id,
    title: `Task ${id}`,
    prompt: "p",
    projectId: "p1",
    threadId,
    modelSelection: { instanceId: "codex", model: "gpt" },
    schedule: { type: "webhook" },
    workspaceStrategy: { type: "root" },
    enabled,
    runtimeMode: "full-access",
  }) as unknown as ScheduledTask;
const model = { instanceId: "codex", model: "gpt" } as unknown as ModelSelection;

let root: Root;
let container: HTMLDivElement;
const render = (threadId: string | null = "thread-1") =>
  act(() =>
    root.render(
      <AssistantSchedulesSection
        environmentId={"hub" as never}
        environmentLabel="Hub"
        assistant={{ id: "a1", projectId: "p1", threadId } as unknown as Assistant}
        modelSelection={model}
      />,
    ),
  );
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const toggle = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.navigate.mockReset();
  mocks.start.mockReset();
  mocks.setEnabled.mockReset();
  mocks.tasks = [task("1", "thread-1"), task("2", "other-thread"), task("3", null, false)];
});
afterEach(() => act(() => root.unmount()));

describe("AssistantSchedulesSection", () => {
  it("lists only the tasks bound to the assistant's conversation", () => {
    render();
    expect(container.textContent).toContain("Task 1");
    expect(container.textContent).not.toContain("Task 2");
    expect(container.textContent).not.toContain("Task 3");
  });

  it("opens the editor with the tapped task's draft", () => {
    render();
    act(() => button("Edit Task 1").click());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "hub",
      environmentLabel: "Hub",
      draft: expect.objectContaining({ task: mocks.tasks[0], threadId: "thread-1" }),
    });
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskEdit");
  });

  it("pauses and resumes a task through the switch", () => {
    mocks.tasks = [task("1", "thread-1", true), task("4", "thread-1", false)];
    render();
    expect(container.textContent).toContain("Paused");
    act(() => toggle("Task 1 enabled").click());
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      environmentId: "hub",
      input: { id: "1", enabled: false },
    });
    act(() => toggle("Task 4 enabled").click());
    expect(mocks.setEnabled).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { id: "4", enabled: true },
    });
  });

  it("shows when a schedule runs next and why the last run failed, and can run it now", () => {
    const tomorrow = "2099-03-04T12:00:00.000Z";
    mocks.tasks = [
      {
        ...task("1", "thread-1"),
        schedule: { type: "interval", everyMs: 3_600_000 },
        nextRunAt: tomorrow,
        lastRunStatus: "failed",
        lastRunError: "Provider said no",
      },
      {
        ...task("2", "thread-1"),
        schedule: { type: "interval", everyMs: 3_600_000 },
        lastRunStatus: "running",
      },
      task("3", "thread-1"),
    ];
    render();
    expect(container.textContent).toMatch(/Next Mar 4, /);
    expect(container.textContent).toContain("Last run failed: Provider said no");
    act(() => button("Run Task 1 now").click());
    expect(mocks.setEnabled).toHaveBeenCalledWith({ environmentId: "hub", input: { id: "1" } });
    // A running schedule cannot be started again, and a webhook one runs on its URL.
    expect((button("Run Task 2 now") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Run Task 3 now"]')).toBeNull();
  });

  it("starts a new schedule bound to the assistant's thread", () => {
    render();
    act(() => button("New routine").click());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "hub",
      environmentLabel: "Hub",
      draft: expect.objectContaining({
        task: null,
        projectId: "p1",
        threadId: "thread-1",
        modelSelection: model,
      }),
    });
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskNew");
  });

  it("cannot add a schedule before the assistant has a conversation", () => {
    render(null);
    expect((button("New routine") as HTMLButtonElement).disabled).toBe(true);
  });
});
