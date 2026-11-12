import type { ReactNode } from "react";
import { HEAVY_QUEUE_DEFAULTS, type HeavyQueueState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  scope: { environmentIds: ["env"] } as { environmentIds: string[] },
  state: null as unknown as HeavyQueueState,
  target: null as string | null,
  runner: { runnerEnabled: false, runnerWhere: "mac" },
  actions: {
    canChange: true,
    setEnabled: vi.fn(),
    setPaused: vi.fn(),
    setRule: vi.fn(),
    setMaxRunning: vi.fn(),
    setClaudeHook: vi.fn(),
    setDeviceIdleMinutes: vi.fn(),
    setMacCpuCeilingPercent: vi.fn(),
    setMacMemoryFloorPercent: vi.fn(),
    setHeavyOverLimitSeconds: vi.fn(),
  },
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: mocks.scope, environment: { environmentId: "env" } }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "env", workspaceRoot: "/work/app", title: "App Project" }],
}));
vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => mocks.state }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: typeof mocks.runner) => unknown) => select(mocks.runner),
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("../statusBar/useKillTarget", () => ({ useHeavyQueueActions: () => mocks.actions }));
vi.mock("./settingsLayout", () => ({
  SettingResetButton: () => null,
  useSettingsSearchTargetId: () => mocks.target,
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <p>{status}</p>
      {control}
      {children}
    </div>
  ),
}));

import { HeavyWorkSettingsSection } from "./HeavyWorkSettings";

const setup = (over: Partial<HeavyQueueState> = {}) => {
  mocks.actions.setEnabled.mockReset();
  mocks.actions.setPaused.mockReset();
  mocks.actions.setRule.mockReset();
  mocks.actions.setMaxRunning.mockReset();
  mocks.actions.setClaudeHook.mockReset();
  mocks.actions.setDeviceIdleMinutes.mockReset();
  mocks.actions.setMacCpuCeilingPercent.mockReset();
  mocks.actions.setMacMemoryFloorPercent.mockReset();
  mocks.actions.setHeavyOverLimitSeconds.mockReset();
  mocks.target = null;
  mocks.actions.canChange = true;
  mocks.scope = { environmentIds: ["env"] };
  mocks.runner = { runnerEnabled: false, runnerWhere: "mac" };
  mocks.state = {
    ...HEAVY_QUEUE_DEFAULTS,
    entries: [],
    enabled: true,
    paused: false,
    rules: [],
    maxRunning: 3,
    reasons: {},
    room: true,
    claudeHookInstalled: false,
    deviceIdleMinutes: 20,
    machine: null,
    hold: null,
    linux: null,
    macOnly: [],
    routes: {},
    ...over,
  };
};

it("changes the pause, the Mac limits and the other rows", async () => {
  setup();
  await using screen = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect.element(screen.getByRole("group", { name: "This Mac" })).toBeVisible();
  await userEvent.click(screen.getByRole("switch", { name: "Pause the heavy work queue" }));
  expect(mocks.actions.setPaused).toHaveBeenCalledWith(true);
  await userEvent.click(screen.getByRole("button", { name: "Increase Jobs at once on this Mac" }));
  expect(mocks.actions.setMaxRunning).toHaveBeenCalledWith(4);
  for (const [label, typed, action, saved] of [
    ["CPU limit", "85", mocks.actions.setMacCpuCeilingPercent, 85],
    ["Keep memory free", "1", mocks.actions.setMacMemoryFloorPercent, 5],
    ["Over the limit for", "999", mocks.actions.setHeavyOverLimitSeconds, 300],
  ] as const) {
    const field = screen.getByLabelText(label, { exact: true });
    await field.fill(typed);
    await field.element().blur();
    expect(action).toHaveBeenCalledWith(saved);
  }
  // Typing the saved value again saves nothing.
  const cpu = screen.getByLabelText("CPU limit", { exact: true });
  await cpu.fill("70");
  await cpu.element().blur();
  expect(mocks.actions.setMacCpuCeilingPercent).toHaveBeenCalledTimes(1);
  await userEvent.click(
    screen.getByRole("switch", {
      name: "Queue heavy commands from Claude Code sessions outside T3 Code",
    }),
  );
  expect(mocks.actions.setClaudeHook).toHaveBeenCalledWith(true);
  const idle = screen.getByRole("combobox", { name: "Power off idle simulators after" });
  await expect.element(idle).toHaveTextContent("20 min");
  await userEvent.click(idle);
  await userEvent.click(screen.getByRole("option", { name: "Off" }));
  expect(mocks.actions.setDeviceIdleMinutes).toHaveBeenCalledWith(0);
});

it("hides the queue rows while the queue is off, and a search still reaches one with why", async () => {
  setup();
  await using on = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect.element(on.getByRole("heading", { name: "Heavy work queue" })).toBeVisible();
  await expect.element(on.getByText("Heavy jobs wait their turn on this Mac.")).toBeVisible();
  await userEvent.click(on.getByRole("switch", { name: "Use the heavy work queue" }));
  expect(mocks.actions.setEnabled).toHaveBeenCalledWith(false);

  setup({ enabled: false, paused: true, rules: [{ root: "/work/app", priority: "first" }] });
  // The Runner being on changes the mode line, never which queue rows show.
  mocks.runner = { runnerEnabled: true, runnerWhere: "linux" };
  await using off = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect
    .element(
      off.getByText(
        "No queue: listed commands wait for a Linux slot, the rest start here right away.",
      ),
    )
    .toBeVisible();
  for (const title of ["Pause heavy work queue", "CPU limit", "Heavy work priority by project"]) {
    expect(off.getByRole("heading", { name: title }).elements()).toHaveLength(0);
  }
  expect(off.getByRole("group", { name: "This Mac" }).elements()).toHaveLength(0);
  await expect
    .element(
      off.getByRole("switch", {
        name: "Queue heavy commands from Claude Code sessions outside T3 Code",
      }),
    )
    .toBeEnabled();
  const queue = off.getByRole("switch", { name: "Use the heavy work queue" });
  await expect.element(queue).not.toBeChecked();
  await userEvent.click(queue);
  expect(mocks.actions.setEnabled).toHaveBeenCalledWith(true);

  setup({ enabled: false, macCpuCeilingPercent: 60 });
  mocks.target = "heavy-work-cpu-ceiling";
  await using searched = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect.element(searched.getByRole("heading", { name: "CPU limit" })).toBeVisible();
  await expect
    .element(searched.getByText("Only applies while the heavy work queue is on."))
    .toBeVisible();
  await expect.element(searched.getByLabelText("CPU limit", { exact: true })).toBeDisabled();
  expect(searched.getByRole("heading", { name: "Keep memory free" }).elements()).toHaveLength(0);
});

it("lists the project rules and removes one", async () => {
  setup({
    rules: [
      { root: "/work/app", priority: "first" },
      { root: "/gone", priority: "last" },
    ],
  });
  await using screen = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect.element(screen.getByText("App Project")).toBeVisible();
  await expect.element(screen.getByText("/gone")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove the priority rule for App Project" }),
  );
  expect(mocks.actions.setRule).toHaveBeenCalledWith("/work/app", null);
});

it("points at the missing choice when no single environment is selected, and locks without permission", async () => {
  setup();
  mocks.scope = { environmentIds: ["a", "b"] };
  await using several = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect
    .element(several.getByText("Choose one environment to manage its queue."))
    .toBeVisible();
  setup({ rules: [{ root: "/gone", priority: "last" }] });
  mocks.actions.canChange = false;
  await using locked = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect
    .element(locked.getByRole("switch", { name: "Pause the heavy work queue" }))
    .toBeDisabled();
  await expect
    .element(locked.getByRole("switch", { name: "Use the heavy work queue" }))
    .toBeDisabled();
});
