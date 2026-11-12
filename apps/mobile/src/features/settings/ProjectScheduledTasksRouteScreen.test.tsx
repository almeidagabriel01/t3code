// @effect-diagnostics globalDate:off - Builds local wall-clock fixtures for the agenda.
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    data: null as { tasks: unknown[] } | null,
    error: null as string | null,
    canOperate: true,
    now: 0,
    setEnabled: vi.fn(),
    runNow: vi.fn(),
    startEditor: vi.fn(),
    navigate: vi.fn(),
    selectDetail: vi.fn(),
    alert: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Pressable: (props: {
    accessibilityLabel?: string;
    onPress?: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.canOperate }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../components/ui/IconButton", () => ({
  IconButton: (props: { accessibilityLabel: string; disabled?: boolean; onPress: () => void }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: ReadonlyArray<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: (props: {
    actions: ReadonlyArray<{ accessibilityLabel: string; onPress: () => void }>;
    children?: ReactNode;
  }) => (
    <>
      {props.actions.map((action) => (
        <button
          key={action.accessibilityLabel}
          aria-label={action.accessibilityLabel}
          onClick={action.onPress}
        />
      ))}
      {props.children}
    </>
  ),
}));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => mocks.now }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.data, error: mocks.error }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => "live",
    setScheduledTaskEnabled: { permissionAtom: () => "permission" },
    runScheduledTaskNow: "run",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "run" ? mocks.runNow : mocks.setEnabled),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: { env: { environmentLabel: "Studio Mac" } },
  }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => mocks.selectDetail,
}));
vi.mock("./scheduled-task-editor-state", () => ({ startScheduledTaskEditor: mocks.startEditor }));
vi.mock("./scheduledTaskDraft", () => ({
  editDraft: (task: { id: string }) => ({ draftOf: task.id }),
}));
vi.mock("./scheduledTaskPresentation", () => ({
  describeSchedule: () => "Daily",
  formatNextScheduledTaskRun: () => "in 2h",
}));

import { ProjectScheduledTasksRouteScreen } from "./ProjectScheduledTasksRouteScreen";

const environmentId = "env" as EnvironmentId;
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
const iso = (time: number) => new Date(time).toISOString();
const task = (title: string, overrides: Partial<ScheduledTask> = {}) =>
  ({
    id: title,
    title,
    projectId: "p1",
    threadId: null,
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "18:00" },
    nextRunAt: iso(at(12, 18)),
    lastRunAt: null,
    lastRunStatus: "never",
    runCount: 0,
    ...overrides,
  }) as ScheduledTask;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.data = { tasks: [] };
  mocks.error = null;
  mocks.canOperate = true;
  mocks.now = at(12, 9);
  mocks.setEnabled.mockReset().mockResolvedValue(AsyncResult.success({}));
  mocks.runNow.mockReset().mockResolvedValue(AsyncResult.success({}));
  for (const mock of [mocks.startEditor, mocks.navigate, mocks.selectDetail, mocks.alert]) {
    mock.mockReset();
  }
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const mount = () =>
  act(async () =>
    root.render(
      <ProjectScheduledTasksRouteScreen
        route={{ params: { environmentId, projectId: "p1" } } as never}
      />,
    ),
  );
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent === label,
  );
const press = (label: string) => act(async () => button(label)?.click());
const labels = () =>
  [...host.querySelectorAll("button")].map((node) => node.getAttribute("aria-label") ?? "");

describe("ProjectScheduledTasksRouteScreen", () => {
  it("lays this project's runs on today and tomorrow, then lists its tasks in run order", async () => {
    mocks.data = {
      tasks: [
        task("Nightly build"),
        task("Morning digest", {
          schedule: { type: "once", runAt: iso(at(12, 10)) } as ScheduledTask["schedule"],
          nextRunAt: iso(at(12, 10)),
        }),
        task("Paused sync", { enabled: false }),
        task("Elsewhere", { projectId: "p2" as never }),
        task("Checked", { enabled: false, lastRunAt: iso(at(12, 7)), lastRunStatus: "failed" }),
      ],
    };
    await mount();
    const agenda = labels().filter((label) => label.includes(", "));
    expect(agenda.filter((label) => label.startsWith("Nightly build"))).toHaveLength(2);
    expect(agenda.filter((label) => label.startsWith("Morning digest"))).toHaveLength(1);
    expect(agenda.some((label) => /^Checked, .* · failed$/.test(label))).toBe(true);
    expect(host.textContent).toContain("Today");
    expect(host.textContent).toContain("Tomorrow");
    expect(host.textContent).not.toContain("Elsewhere");
    expect(labels().filter((label) => label.startsWith("Open "))).toEqual([
      "Open Morning digest",
      "Open Nightly build",
      "Open Checked",
      "Open Paused sync",
    ]);
    expect(host.textContent).toContain("Daily · in 2h");
    expect(host.textContent).toContain("Daily · Paused");

    await press(agenda.find((label) => label.startsWith("Morning digest"))!);
    expect(mocks.startEditor).toHaveBeenCalledWith({
      environmentId,
      environmentLabel: "Studio Mac",
      draft: { draftOf: "Morning digest" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskEdit");
  });

  it("runs, pauses and resumes a task, and reports a failure", async () => {
    mocks.data = { tasks: [task("Nightly build"), task("Paused sync", { enabled: false })] };
    await mount();

    await press("Run Nightly build now");
    expect(mocks.runNow).toHaveBeenCalledWith({ environmentId, input: { id: "Nightly build" } });
    await press("Pause Nightly build");
    expect(mocks.setEnabled).toHaveBeenCalledWith({
      environmentId,
      input: { id: "Nightly build", enabled: false },
    });

    mocks.setEnabled.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Offline"))));
    await press("Resume Paused sync");
    expect(mocks.setEnabled).toHaveBeenLastCalledWith({
      environmentId,
      input: { id: "Paused sync", enabled: true },
    });
    expect(mocks.alert).toHaveBeenCalledWith("Could not resume the task", expect.any(String));
  });

  it("disables controls without permission and has no run now for webhook tasks", async () => {
    mocks.canOperate = false;
    mocks.data = {
      tasks: [task("Hook", { schedule: { type: "webhook" } as never, nextRunAt: null })],
    };
    await mount();
    expect(button("Pause Hook")?.disabled).toBe(true);
    expect(button("Run Hook now")).toBeUndefined();
  });

  it("opens a task's thread and the scheduled task settings", async () => {
    mocks.data = { tasks: [task("Bound", { threadId: "thread-1" as never })] };
    await mount();
    await press("Open thread");
    expect(mocks.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId: "env", threadId: "thread-1" },
    });
    await press("Open task");
    expect(mocks.startEditor).toHaveBeenCalledTimes(1);
    await press("Manage scheduled tasks");
    expect(mocks.navigate).toHaveBeenLastCalledWith("SettingsScheduledTasks");
  });

  it.each([
    ["loading", null, null, "Loading scheduled tasks…"],
    ["failed", { tasks: [] }, "Server unreachable", "Could not load scheduled tasks"],
    ["empty", { tasks: [] }, null, "No scheduled tasks in this project"],
  ] as const)("shows the %s state", async (_name, data, error, text) => {
    mocks.data = data === null ? null : { tasks: [] };
    mocks.error = error;
    await mount();
    expect(host.textContent).toContain(text);
  });
});
