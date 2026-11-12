import type { ReactNode } from "react";
import type { HeavyQueueState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  scope: { environmentIds: ["env"] } as { environmentIds: string[] },
  state: null as unknown as HeavyQueueState,
  actions: {
    canChange: true,
    setEnabled: vi.fn(),
    setPaused: vi.fn(),
    setRule: vi.fn(),
    setMaxRunning: vi.fn(),
    setClaudeHook: vi.fn(),
    setDeviceIdleMinutes: vi.fn(),
  },
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: mocks.scope, environment: { environmentId: "env" } }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ environmentId: "env", workspaceRoot: "/work/app", title: "App Project" }],
}));
vi.mock("../../state/heavyQueue", () => ({ useHeavyQueue: () => mocks.state }));
vi.mock("../statusBar/useKillTarget", () => ({ useHeavyQueueActions: () => mocks.actions }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
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
  mocks.actions.canChange = true;
  mocks.scope = { environmentIds: ["env"] };
  mocks.state = {
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
    ...over,
  };
};

it("changes the slot limit and the pause from the settings rows", async () => {
  setup();
  await using screen = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await userEvent.click(screen.getByRole("switch", { name: "Pause the heavy work queue" }));
  expect(mocks.actions.setPaused).toHaveBeenCalledWith(true);
  await userEvent.click(
    screen.getByRole("combobox", { name: "Run up to this many heavy jobs at once" }),
  );
  await userEvent.click(screen.getByRole("option", { name: "6" }));
  expect(mocks.actions.setMaxRunning).toHaveBeenCalledWith(6);
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

it("switches the queue off and on, and locks the other rows while it is off without changing them", async () => {
  setup();
  await using on = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  await expect.element(on.getByRole("heading", { name: "Heavy work queue" })).toBeVisible();
  await expect
    .element(on.getByText(/Off: heavy jobs start right away and agents do not ask first\./))
    .toBeVisible();
  await userEvent.click(on.getByRole("switch", { name: "Use the heavy work queue" }));
  expect(mocks.actions.setEnabled).toHaveBeenCalledWith(false);

  setup({
    enabled: false,
    paused: true,
    maxRunning: 6,
    rules: [{ root: "/work/app", priority: "first" }],
  });
  await using off = await render(<HeavyWorkSettingsSection />, { router: false }); // rows are mocked
  const pause = off.getByRole("switch", { name: "Pause the heavy work queue" });
  await expect.element(pause).toBeDisabled();
  await expect.element(pause).toBeChecked();
  const limit = off.getByRole("combobox", { name: "Run up to this many heavy jobs at once" });
  await expect.element(limit).toBeDisabled();
  await expect
    .element(
      off.getByRole("switch", {
        name: "Queue heavy commands from Claude Code sessions outside T3 Code",
      }),
    )
    .toBeEnabled();
  await expect.element(limit).toHaveTextContent("6");
  await expect.element(off.getByText("Always first")).toBeVisible();
  await expect
    .element(off.getByRole("button", { name: "Remove the priority rule for App Project" }))
    .toBeDisabled();
  const queue = off.getByRole("switch", { name: "Use the heavy work queue" });
  await expect.element(queue).not.toBeChecked();
  await userEvent.click(queue);
  expect(mocks.actions.setEnabled).toHaveBeenCalledWith(true);
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
