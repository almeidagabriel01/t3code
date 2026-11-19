import {
  CONNECT_ENVIRONMENT_FOR_KEYBINDINGS,
  CONNECT_ENVIRONMENT_FOR_MAINTENANCE_SETTINGS,
  CONNECT_ENVIRONMENT_FOR_SCHEDULED_TASKS,
  CONNECT_ENVIRONMENT_FOR_THREAD_SETTINGS,
  CONNECT_ENVIRONMENT_FOR_WORKTREE_SETTINGS,
} from "@t3tools/client-runtime/settings-empty-selection";
import type { ComponentType } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { MaintenanceSettingsPanel, ThreadsSettingsPanel } from "./SettingsPanels";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { WorktreesSettingsPanel } from "./WorktreesSettings";

const mocks = vi.hoisted(() => ({ environments: [] as unknown[] }));

// The test app has no reachable server, so without this override the scope has no environment.
vi.mock(import("~/state/environments"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironments: (() =>
      mocks.environments.length === 0
        ? actual.useEnvironments()
        : { isReady: true, environments: mocks.environments }) as never,
  };
});

function setup(environments: unknown[] = []) {
  mocks.environments = environments;
}

const disconnected = {
  environmentId: "env-mac",
  label: "Mac",
  displayUrl: null,
  relayManaged: false,
  connection: { phase: "connecting" },
  serverConfig: null,
};

const cases: ReadonlyArray<{
  name: string;
  Panel: ComponentType;
  notice: string;
  serverRows: readonly string[];
  clientRows: readonly string[];
}> = [
  {
    name: "Threads",
    Panel: ThreadsSettingsPanel,
    notice: CONNECT_ENVIRONMENT_FOR_THREAD_SETTINGS,
    serverRows: ["Resume after usage limits", "Text generation model", "Add project starts in"],
    clientRows: [],
  },
  {
    name: "Worktrees",
    Panel: WorktreesSettingsPanel,
    notice: CONNECT_ENVIRONMENT_FOR_WORKTREE_SETTINGS,
    serverRows: ["Start from remote", "Worktree branch naming", "Delete merged worktrees"],
    clientRows: [],
  },
  {
    name: "Maintenance",
    Panel: MaintenanceSettingsPanel,
    notice: CONNECT_ENVIRONMENT_FOR_MAINTENANCE_SETTINGS,
    serverRows: ["Provider update checks", "Continue threads after restarts", "Detect problems"],
    clientRows: ["View diagnostics"],
  },
];

it.each(cases)(
  "$name shows one connect notice in place of its server sections without an environment",
  async ({ Panel, notice, serverRows, clientRows }) => {
    setup();
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <Panel />
      </SettingsScopeProvider>,
    );
    await expect.element(page.getByText(notice, { exact: true })).toBeVisible();
    expect(screen.container.textContent?.split(notice)).toHaveLength(2);
    for (const row of serverRows) {
      expect(page.getByText(row, { exact: true }).elements()).toHaveLength(0);
    }
    for (const row of clientRows) {
      await expect.element(page.getByText(row, { exact: true })).toBeVisible();
    }
    expect(screen.container.textContent).not.toContain("must support restart continuation");
  },
);

it.each(cases)(
  "$name keeps its rows, without the connect notice, while its environment reconnects",
  async ({ Panel, notice, serverRows }) => {
    setup([disconnected]);
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <Panel />
      </SettingsScopeProvider>,
    );
    await expect.element(page.getByText(serverRows[0]!, { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain(notice);
  },
);

it.each([
  {
    name: "Keybindings",
    Panel: KeybindingsSettingsPanel,
    notice: CONNECT_ENVIRONMENT_FOR_KEYBINDINGS,
    hiddenRows: ["Command Palette: Toggle"],
  },
  {
    name: "Scheduled tasks",
    Panel: ScheduledTasksSettings,
    notice: CONNECT_ENVIRONMENT_FOR_SCHEDULED_TASKS,
    hiddenRows: ["No environments available"],
  },
])(
  "$name shows the shared Server environment notice without an environment",
  async ({ Panel, notice, hiddenRows }) => {
    setup();
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <Panel />
      </SettingsScopeProvider>,
    );
    await expect.element(page.getByText(notice, { exact: true })).toBeVisible();
    await expect.element(page.getByText("Server environment", { exact: true })).toBeVisible();
    expect(screen.container.textContent?.split(notice)).toHaveLength(2);
    for (const row of hiddenRows) {
      expect(page.getByText(row, { exact: true }).elements()).toHaveLength(0);
    }
  },
);

it.each([
  { state: "without an environment", environments: [], rowsVisible: false },
  { state: "while its environment reconnects", environments: [disconnected], rowsVisible: true },
])(
  "Keybindings disables search and Add keybinding $state",
  async ({ environments, rowsVisible }) => {
    setup(environments);
    await using screen = await render(
      <SettingsScopeProvider search={{}} onChange={() => {}}>
        <KeybindingsSettingsPanel />
      </SettingsScopeProvider>,
    );
    await expect
      .element(page.getByRole("searchbox", { name: "Search keybindings" }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Add keybinding" })).toBeDisabled();
    if (rowsVisible) {
      await expect.element(page.getByText("Command Palette: Toggle")).toBeVisible();
      expect(screen.container.textContent).not.toContain(CONNECT_ENVIRONMENT_FOR_KEYBINDINGS);
    }
  },
);
