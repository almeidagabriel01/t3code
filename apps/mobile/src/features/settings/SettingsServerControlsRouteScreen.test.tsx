import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    runner: null as null | {
      projectSelected: boolean;
      overridden: (key: string) => boolean;
      mixed: (key: string) => boolean;
      disabledFor: (key: string) => boolean;
      write: (patch: ServerSettingsPatch) => void;
      reset: (key: string) => void;
      severalMachines?: boolean;
    },
    updateSettings: vi.fn(),
    alert: vi.fn(),
    selectAll: vi.fn(),
    selectAllProjects: vi.fn(),
    toggleProject: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    projectSelected: false,
    projectIds: ["project"],
    projectModels: null as null | {
      targets: unknown[];
      showAssistants: boolean;
      onReset: () => void;
    },
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({}),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("../../components/ui/NumberField", () => ({
  NumberField: (props: {
    label: string;
    value: number;
    onValueChange: (value: number) => void;
  }) => <button aria-label={props.label} onClick={() => props.onValueChange(props.value + 1)} />,
}));
vi.mock("./components/SourceControlSignInSection", () => ({
  SourceControlSignInSection: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () =>
    new Set(
      mocks.targets
        .map((target) => target.environmentId)
        .filter((environmentId) => !mocks.readOnly.has(environmentId)),
    ),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/keepAwake", () => ({ useKeepAwakeStatus: () => null }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({
  RUNTIME_MODE_CHOICES: [],
  withManagedRuntimeModeLimits: (choices: readonly unknown[]) => choices,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({
    title: "Filter",
    icon: "line.3.horizontal.decrease.circle",
    items: [],
  }),
}));
vi.mock("./components/DatabaseStorageNotice", () => ({ DatabaseStorageNotice: () => null }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../../components/ui/ListChoiceRow", () => ({ ListChoiceRow: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/FallbackModelsSection", () => ({ FallbackModelsSection: () => null }));
vi.mock("./components/KeepAwakeSection", () => ({
  KeepAwakeSection: (props: { value: string | null; onChange: (mode: "always") => void }) => (
    <button
      aria-label="keep awake"
      data-value={String(props.value)}
      onClick={() => props.onChange("always")}
    />
  ),
}));
vi.mock("./components/WorktreeSnapshotsSection", () => ({
  WorktreeSnapshotsSection: (props: {
    value: number | null | undefined;
    onChange: (days: number | null) => void;
  }) => (
    <button
      aria-label="worktree snapshots"
      data-value={String(props.value)}
      onClick={() => props.onChange(7)}
    />
  ),
}));
vi.mock("./components/HeavyQueueSection", () => ({
  HeavyCommandsSection: () => null,
  HeavyQueueSection: (props: { environmentId: string; runner: object; machine?: string }) => (
    <i
      aria-label="heavy queue"
      data-env={props.environmentId}
      data-machine={props.machine}
      data-runner={JSON.stringify(props.runner)}
    />
  ),
}));
vi.mock("./components/RunnerSection", () => ({
  RunnerSection: (props: NonNullable<typeof mocks.runner>) => {
    mocks.runner = props;
    return null;
  },
}));
vi.mock("./components/FolderModelsSection", () => ({ FolderModelsSection: () => null }));
vi.mock("./components/ProjectModelSections", () => ({
  ProjectModelSections: (props: NonNullable<typeof mocks.projectModels>) => {
    mocks.projectModels = props;
    return null;
  },
}));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    projectGroups: [
      {
        key: "linked-group",
        members: [{ project: { environmentId: "local", id: "linked" } }],
      },
    ],
    selectAll: mocks.selectAll,
    selectAllProjects: mocks.selectAllProjects,
    toggleProject: mocks.toggleProject,
    selectedTargets: mocks.targets,
    selectedProjectGroups: mocks.projectSelected
      ? [
          {
            key: "project",
            label: "Project",
            members: mocks.targets.flatMap((target) =>
              mocks.projectIds.map((id) => ({
                project: { environmentId: target.environmentId, id },
              })),
            ),
          },
        ]
      : null,
    selectedProjects: mocks.projectSelected
      ? mocks.targets.flatMap((target) =>
          mocks.projectIds.map((id) => ({ environmentId: target.environmentId, id })),
        )
      : null,
  }),
}));

import {
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsThreadsRouteScreen,
  SettingsWorktreesRouteScreen,
} from "./SettingsServerControlsRouteScreen";

function environment(environmentId: string, label: string) {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultAutoPull: false,
        sidebarAutoSettleOnMerge: false,
        // Off by default; on, the days field renders.
        toolOutputHistoryDays: 30,
      },
      environment: {
        capabilities: { projectSettingsOverrides: true, threadAutoSettlement: true },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.projectSelected = false;
  mocks.projectIds = ["project"];
  mocks.projectModels = null;
  for (const fn of [mocks.selectAll, mocks.selectAllProjects, mocks.toggleProject]) fn.mockReset();
  mocks.readOnly = new Set();
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsServerControlsRouteScreen", () => {
  it("sends a draft saved during a pending write once that write settles", async () => {
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsWorktreesRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });

  it("holds auto-settle changes until a pending project override write settles", async () => {
    mocks.projectSelected = true;
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsThreadsRouteScreen route={{ params: undefined } as never} />));
    const toggle = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
        (button) => button.textContent === label,
      )!;

    act(() => toggle("Agent browser access").click());
    act(() => toggle("Auto-settle merged threads").click());

    // Both rewrite the whole project override, so a second write planned now would drop the first.
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(AsyncResult.success(undefined)));
  });

  it("scopes Settings to the project a link names, once", () => {
    const route = { params: { environmentId: "local", projectId: "linked" } } as never;
    act(() => root.render(<SettingsThreadsRouteScreen route={route} />));
    act(() => root.render(<SettingsThreadsRouteScreen route={route} />));
    expect(mocks.selectAll).toHaveBeenCalledOnce();
    expect(mocks.selectAllProjects).toHaveBeenCalledOnce();
    expect(mocks.toggleProject).toHaveBeenCalledExactlyOnceWith("linked-group");
  });

  it("shows the project's models at project scope and resets its model override", async () => {
    act(() => root.render(<SettingsThreadsRouteScreen route={{ params: undefined } as never} />));
    expect(mocks.projectModels).toBeNull();
    // The compiler memoizes the page, so the project scope needs a fresh mount.
    act(() => root.unmount());
    root = createRoot(container);
    mocks.projectSelected = true;
    mocks.targets[0]!.serverConfig.settings = {
      ...mocks.targets[0]!.serverConfig.settings,
      projectSettingsOverrides: {
        ["project" as ProjectId]: {
          defaultAutoPull: true,
          defaultModelSelection: { instanceId: "codex" as never, model: "gpt-5.5" },
        },
      },
    };
    act(() => root.render(<SettingsThreadsRouteScreen route={{ params: undefined } as never} />));
    expect(mocks.projectModels).toMatchObject({ targets: [{}], showAssistants: true });
    await act(async () => mocks.projectModels!.onReset());
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { defaultAutoPull: true } } } },
    });
  });

  it("writes a project override to every selected project", async () => {
    mocks.projectSelected = true;
    mocks.projectIds = ["a", "b"];
    act(() => root.render(<SettingsThreadsRouteScreen route={{ params: undefined } as never} />));
    const toggle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Agent browser access",
    )!;

    await act(async () => toggle.click());

    expect(mocks.updateSettings.mock.calls.map(([call]) => call.environmentId)).toEqual(["local"]);
    expect(JSON.stringify(mocks.updateSettings.mock.calls[0])).toMatch(/"a".*"b"|"b".*"a"/);
  });

  it("shows each selected environment's heavy-work queue, named once there are several", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const queues = () =>
      [...container.querySelectorAll<HTMLElement>('[aria-label="heavy queue"]')].map((queue) => [
        queue.dataset.env,
        queue.dataset.machine,
      ]);
    expect(queues()).toEqual([["local", undefined]]);
    expect(mocks.runner!.severalMachines).toBe(false);
    act(() => root.unmount());

    mocks.targets = [environment("local", "Local"), environment("remote", "Remote")];
    root = createRoot(container);
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(queues()).toEqual([
      ["local", "Local"],
      ["remote", "Remote"],
    ]);
    expect(mocks.runner!.severalMachines).toBe(true);
  });

  it("passes the effective Runner mode to the heavy-work queue", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(
      JSON.parse(
        container.querySelector<HTMLElement>('[aria-label="heavy queue"]')!.dataset.runner!,
      ),
    ).toEqual({ enabled: false, where: "mac", overflow: 3 });
  });

  it("saves Runner settings for the environment, or as project overrides it can reset", async () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(mocks.runner!.projectSelected).toBe(false);
    await act(async () => mocks.runner!.write({ runnerHost: "box" }));
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { runnerHost: "box" } },
    });
    act(() => root.unmount());

    mocks.projectSelected = true;
    const project = environment("local", "Local");
    project.serverConfig.settings = {
      ...project.serverConfig.settings,
      projectSettingsOverrides: {
        ["project" as ProjectId]: { runnerWhere: "linux", runnerOverflow: 5 },
      },
    };
    mocks.targets = [project];
    root = createRoot(container);
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(mocks.runner!.overridden("runnerWhere")).toBe(true);
    expect(mocks.runner!.overridden("runnerEnabled")).toBe(false);
    expect(mocks.runner!.disabledFor("runnerHost")).toBe(true);
    expect(mocks.runner!.disabledFor("runnerWhere")).toBe(false);
    await act(async () => mocks.runner!.write({ runnerEnabled: true }));
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: {
          projectSettingsOverrides: {
            project: { runnerWhere: "linux", runnerOverflow: 5, runnerEnabled: true },
          },
        },
      },
    });
    await act(async () => mocks.runner!.reset("runnerWhere"));
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { runnerOverflow: 5 } } } },
    });
  });

  it("marks Runner settings mixed only when selected environments differ in content", () => {
    const remote = environment("remote", "Remote");
    remote.serverConfig.settings = {
      ...remote.serverConfig.settings,
      runnerMacOnly: [...remote.serverConfig.settings.runnerMacOnly],
      runnerHost: "box",
    };
    mocks.targets = [environment("local", "Local"), remote];
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(mocks.runner!.mixed("runnerMacOnly")).toBe(false);
    expect(mocks.runner!.mixed("runnerHost")).toBe(true);
  });

  it("saves the keep-awake mode picked on the Maintenance page", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const section = container.querySelector<HTMLButtonElement>('[aria-label="keep awake"]')!;
    expect(section.dataset.value).toBe("off");
    act(() => section.click());
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "local",
      input: { patch: { keepAwake: "always" } },
    });
  });

  it.each([
    { label: "Days to keep tool output", patch: { toolOutputHistoryDays: 31 } },
    { label: "Minutes before an idle agent closes", patch: { providerIdleTimeoutMinutes: 11 } },
  ])("saves $label on the Maintenance page", ({ label, patch }) => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    act(() => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    expect(mocks.updateSettings).toHaveBeenCalledWith({ environmentId: "local", input: { patch } });
  });

  it("saves the snapshot retention picked on the Maintenance page", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const section = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="worktree snapshots"]')!;
    expect(section().dataset.value).toBe("30");
    act(() => section().click());
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      environmentId: "local",
      input: { patch: { storageCleanup: { worktreeSnapshotsAfterDays: 7 } } },
    });
  });

  it("selects no snapshot retention when machines differ", () => {
    const remote = environment("remote", "Remote");
    remote.serverConfig.settings = {
      ...remote.serverConfig.settings,
      storageCleanup: {
        ...remote.serverConfig.settings.storageCleanup,
        worktreeSnapshotsAfterDays: null,
      },
    };
    mocks.targets = [environment("local", "Local"), remote];
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="worktree snapshots"]')!.dataset
        .value,
    ).toBe("undefined");
  });

  it("disables auto-settle when a selected environment cannot save settings", () => {
    const remote = environment("remote", "Remote");
    // Auto-settle rows skip a server without auto-settlement, but the page still saves to it.
    remote.serverConfig.environment.capabilities.threadAutoSettlement = false;
    mocks.targets = [environment("local", "Local"), remote];
    mocks.readOnly = new Set(["remote"]);
    act(() => root.render(<SettingsThreadsRouteScreen route={{ params: undefined } as never} />));

    const autoSettle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Auto-settle merged threads",
    )!;
    expect(autoSettle.disabled).toBe(true);
  });
});
