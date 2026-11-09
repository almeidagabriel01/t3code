import type { ScheduledTask } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    tasks: [] as unknown[],
    navigate: vi.fn(),
    start: vi.fn(),
    command: vi.fn(),
    confirm: vi.fn(),
    schedule: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Dialog", () => ({
  confirm: (request: { onConfirm: () => void }) => {
    mocks.confirm(request);
    request.onConfirm();
  },
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { children?: ReactNode; footer?: string }) => (
    <section>
      {props.children}
      <p>{props.footer}</p>
    </section>
  ),
}));
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
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
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
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => Date.parse("2026-11-09T10:00:00Z") }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => ({}),
    setScheduledTaskEnabled: {},
    runScheduledTaskNow: {},
    deleteScheduledTask: {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.command }));
vi.mock("../settings/scheduled-task-editor-state", () => ({
  startScheduledTaskEditor: mocks.start,
}));
vi.mock("../settings/settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: [{ environmentId: "hub", label: "Hub" }],
  }),
}));
vi.mock("./useScheduleInGroup", () => ({ useScheduleInGroup: () => mocks.schedule }));

import { GroupRoutinesSection, groupRoutineDescription } from "./GroupRoutinesSection";

const task = (id: string, extra: object = {}) =>
  ({
    id,
    title: `Routine ${id}`,
    prompt: "p",
    projectId: "p1",
    threadId: null,
    assistantTeamId: "g1",
    modelSelection: { instanceId: "codex", model: "gpt" },
    schedule: { type: "fixed_time", timeOfDay: "09:00" },
    workspaceStrategy: { type: "root" },
    enabled: true,
    nextRunAt: "2026-11-10T12:00:00.000Z",
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    runtimeMode: "full-access",
    ...extra,
  }) as unknown as ScheduledTask;

const NOW = Date.parse("2026-11-09T10:00:00Z");

describe("groupRoutineDescription", () => {
  const cases: ReadonlyArray<
    readonly [string, object, ReadonlyArray<string>, ReadonlyArray<string>]
  > = [
    ["a live routine", {}, ["Every day at", "Next "], ["Paused"]],
    ["paused", { enabled: false }, ["Paused"], ["Next"]],
    [
      "stopped at its limit",
      { enabled: false, maxRuns: 3, runCount: 3 },
      ["Stopped at its run limit", "3 of 3 runs"],
      ["Paused"],
    ],
    ["with no next run", { nextRunAt: null }, ["Not scheduled"], ["Next"]],
    ["that catches up", { missedRunPolicy: "once" }, ["Catches up once if missed"], []],
    [
      "that failed",
      { lastRunStatus: "failed", lastRunError: "This group is archived." },
      ["Last run failed: This group is archived."],
      [],
    ],
    ["that failed without a reason", { lastRunStatus: "failed" }, ["Last run failed"], [": "]],
    ["that posted", { lastRunStatus: "succeeded" }, ["Last run posted"], []],
    ["an interval", { schedule: { type: "interval", everyMs: 3_600_000 } }, ["Every"], []],
  ];
  it.each(cases)("%s", (_name, extra, has, hasNot) => {
    const text = groupRoutineDescription(task("1", extra), NOW);
    for (const part of has) expect(text).toContain(part);
    for (const part of hasNot) expect(text).not.toContain(part);
  });
});

let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(() =>
    root.render(<GroupRoutinesSection environmentId={"hub" as never} teamId={"g1" as never} />),
  );
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.navigate.mockReset();
  mocks.start.mockReset();
  mocks.command.mockReset();
  mocks.confirm.mockReset();
  mocks.schedule.mockReset();
  mocks.tasks = [task("1"), task("2", { assistantTeamId: "g2" }), task("3", { threadId: "t" })];
});
afterEach(() => act(() => root.unmount()));

describe("GroupRoutinesSection", () => {
  it("lists only this group's routines, or says there are none", () => {
    render();
    expect(container.textContent).toContain("Routine 1");
    expect(container.textContent).not.toContain("Routine 2");
    mocks.tasks = [];
    render();
    expect(container.textContent).toContain("No routines in this group yet.");
  });

  it("opens the editor with the routine's draft", () => {
    render();
    act(() => button("Edit Routine 1").click());
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId: "hub",
      environmentLabel: "Hub",
      draft: expect.objectContaining({ task: mocks.tasks[0], assistantTeamId: "g1" }),
    });
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsScheduledTaskEdit");
  });

  it("runs now, pauses, resumes and deletes after confirming", () => {
    mocks.tasks = [task("1"), task("4", { enabled: false, lastRunStatus: "running" })];
    render();
    act(() => button("Run Routine 1 now").click());
    expect(mocks.command).toHaveBeenLastCalledWith({ environmentId: "hub", input: { id: "1" } });
    expect((button("Run Routine 4 now") as HTMLButtonElement).disabled).toBe(true);
    const toggle = (label: string) =>
      container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    act(() => toggle("Routine 1 enabled").click());
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { id: "1", enabled: false },
    });
    act(() => toggle("Routine 4 enabled").click());
    expect(mocks.command).toHaveBeenLastCalledWith({
      environmentId: "hub",
      input: { id: "4", enabled: true },
    });
    act(() => button("Delete Routine 1").click());
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, title: "Delete the routine Routine 1?" }),
    );
    expect(mocks.command).toHaveBeenLastCalledWith({ environmentId: "hub", input: { id: "1" } });
  });

  it("starts a new routine in the group", () => {
    render();
    act(() => button("New routine").click());
    expect(mocks.schedule).toHaveBeenCalledWith("hub", "g1");
  });
});
