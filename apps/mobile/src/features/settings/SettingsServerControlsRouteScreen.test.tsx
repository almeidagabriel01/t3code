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
    targets: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    projectSelected: false,
    projectIds: ["project"],
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
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  AppTextInput: (props: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (text: string) => void;
    onEndEditing: () => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
      onBlur={props.onEndEditing}
    />
  ),
}));
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
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
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
  HeavyQueueSection: (props: {
    environmentId: string;
    runner: object;
    machine?: string;
    slowAgentJobs: { onChange: (value: boolean) => void };
  }) => (
    <button
      aria-label="heavy queue"
      data-env={props.environmentId}
      data-machine={props.machine}
      data-runner={JSON.stringify(props.runner)}
      onClick={() => props.slowAgentJobs.onChange(false)}
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
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
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
        capabilities: {
          projectSettingsOverrides: true,
          threadAutoSettlement: true,
          projectWorktreeCleanup: true,
          settledWorktreeCleanup: true,
          mergedWorktreeCleanup: true,
        } as Record<string, boolean>,
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
    act(() => root.render(<SettingsThreadsRouteScreen />));
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

  it("writes a project override to every selected project", async () => {
    mocks.projectSelected = true;
    mocks.projectIds = ["a", "b"];
    act(() => root.render(<SettingsThreadsRouteScreen />));
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

  it("passes the effective Runner mode to the heavy-work queue and saves its slow-down switch", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const queue = container.querySelector<HTMLButtonElement>('[aria-label="heavy queue"]')!;
    expect(JSON.parse(queue.dataset.runner!)).toEqual({ enabled: false, where: "mac" });
    act(() => queue.click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { heavySlowAgentJobs: false } },
    });
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
        ["project" as ProjectId]: { runnerWhere: "linux", runnerAskMinutes: 7 },
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
            project: { runnerWhere: "linux", runnerAskMinutes: 7, runnerEnabled: true },
          },
        },
      },
    });
    await act(async () => mocks.runner!.reset("runnerWhere"));
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: { runnerAskMinutes: 7 } } } },
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

  it.each([
    [false, "Detect problems", { detectProblems: false }],
    [
      true,
      "Detect problems in this project",
      { projectSettingsOverrides: { project: { detectProblems: false } } },
    ],
  ] as const)(
    "turns problem detection off from Maintenance (project selected: %s)",
    async (projectSelected, label, patch) => {
      mocks.projectSelected = projectSelected;
      act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
      const toggle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
        (button) => button.textContent === label,
      )!;
      await act(async () => toggle.click());
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        environmentId: "local",
        input: { patch: expect.objectContaining(patch) },
      });
    },
  );

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
    act(() => root.render(<SettingsThreadsRouteScreen />));

    const autoSettle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Auto-settle merged threads",
    )!;
    expect(autoSettle.disabled).toBe(true);
  });

  describe("worktree cleanup", () => {
    const control = (selector: string, text: string) =>
      [...container.querySelectorAll<HTMLElement>(selector)].find(
        (node) => node.textContent === text || node.getAttribute("aria-label") === text,
      )!;
    const radio = (text: string) => control('[role="radio"]', text);
    const toggle = (text: string) => control('[role="switch"]', text);
    const type = (label: string, text: string) => {
      const input = control("input", label) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
    };
    const lastPatch = () => mocks.updateSettings.mock.lastCall![0].input.patch;
    const withSettings = (
      env: ReturnType<typeof environment>,
      cleanup: Record<string, unknown>,
      override?: unknown,
    ) => {
      env.serverConfig.settings = {
        ...env.serverConfig.settings,
        storageCleanup: { ...env.serverConfig.settings.storageCleanup, ...cleanup },
        ...(override === undefined
          ? {}
          : { projectSettingsOverrides: { ["project" as ProjectId]: override } }),
      } as typeof env.serverConfig.settings;
      return env;
    };
    const customProject = (rules: Record<string, unknown> = {}) => {
      mocks.projectSelected = true;
      mocks.targets = [
        withSettings(
          environment("local", "Local"),
          {},
          {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                ...DEFAULT_SERVER_SETTINGS.storageCleanup,
                worktreeMerged: "after-days",
                ...rules,
              },
            },
          },
        ),
      ];
    };

    it("writes each merged option and a valid day count machine-wide", async () => {
      mocks.targets = [
        withSettings(environment("local", "Local"), { worktreeMerged: "after-days" }),
      ];
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      for (const [label, value] of [
        ["Off", "off"],
        ["Right away", "right-away"],
        ["After 7 days", "after-days"],
      ]) {
        await act(async () => radio(label!).click());
        expect(lastPatch()).toEqual({ storageCleanup: { worktreeMerged: value } });
      }
      mocks.updateSettings.mockClear();
      for (const bad of ["0", "366", "1.5", ""]) {
        type("Days unused", bad);
        expect(container.textContent).toContain("Enter a whole number of days from 1 to 365.");
      }
      expect(mocks.updateSettings).not.toHaveBeenCalled();
      type("Days unused", "30");
      expect(lastPatch()).toEqual({ storageCleanup: { worktreeMergedAfterDays: 30 } });
    });

    it("writes merged options and days per project through a custom override", async () => {
      customProject();
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      // The project mode row has an Off too; the merged choices come after it.
      const offs = container.querySelectorAll<HTMLElement>('[role="radio"]');
      await act(async () => [...offs].filter((node) => node.textContent === "Off")[1]!.click());
      expect(lastPatch().projectSettingsOverrides.project.worktreeCleanup).toEqual({
        mode: "custom",
        rules: expect.objectContaining({ worktreeMerged: "off" }),
      });
      type("Days unused", "12");
      expect(
        lastPatch().projectSettingsOverrides.project.worktreeCleanup.rules.worktreeMergedAfterDays,
      ).toBe(12);
    });

    it("writes the Linux copy, deleted-threads, inactive, settled and keep-when controls", async () => {
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      const expectPatch = (cleanup: object) =>
        expect(lastPatch()).toEqual({ storageCleanup: cleanup });
      await act(async () => toggle("Delete the Linux copy too").click());
      expectPatch({ worktreeRunnerCopy: false });
      await act(async () => toggle("Delete worktrees with deleted threads").click());
      expectPatch({ worktreeOnDelete: true });
      await act(async () => toggle("Delete inactive worktrees").click());
      const inactive = DEFAULT_SERVER_SETTINGS.storageCleanup.worktreeAfterDays;
      expectPatch({ worktreeAfterDays: inactive === null ? 8 : null });
      await act(async () => toggle("Delete settled worktrees").click());
      expectPatch({ worktreeSettledAfterDays: 8 });
      await act(async () => radio("Edited tracked files").click());
      expectPatch({ worktreeKeepWhen: "tracked-changes" });
    });

    it("edits and clears the day counts of enabled retention rules", async () => {
      mocks.targets = [
        withSettings(environment("local", "Local"), {
          worktreeAfterDays: 30,
          worktreeSettledAfterDays: 2,
        }),
      ];
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      const days = [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Days"]')];
      expect(days.map((input) => input.value)).toEqual(["30", "2"]);
      await act(async () => toggle("Delete settled worktrees").click());
      expect(lastPatch()).toEqual({ storageCleanup: { worktreeSettledAfterDays: null } });
    });

    it("sets Inherit, Off and Custom per project", async () => {
      mocks.projectSelected = true;
      mocks.targets = [environment("local", "Local")];
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      expect(radio("Inherit").getAttribute("aria-checked")).toBe("true");
      await act(async () => radio("Off").click());
      expect(lastPatch().projectSettingsOverrides.project).toEqual({
        worktreeCleanup: { mode: "off" },
      });
      await act(async () => radio("Custom").click());
      expect(lastPatch().projectSettingsOverrides.project).toEqual({
        worktreeCleanup: { mode: "custom", rules: {} },
      });
      act(() => root.unmount());

      customProject();
      root = createRoot(container);
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      expect(radio("Custom").getAttribute("aria-checked")).toBe("true");
      await act(async () => radio("Inherit").click());
      expect(JSON.stringify(lastPatch())).not.toContain("worktreeCleanup");
    });

    const noRules = {
      worktreeOnDelete: false,
      worktreeMerged: "off",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
    };
    it.each([
      ["every rule off", [{}], false],
      ["deleted threads", [{ worktreeOnDelete: true }], true],
      ["merged", [{ worktreeMerged: "after-days" }], true],
      ["inactive", [{ worktreeAfterDays: 8 }], true],
      ["settled", [{ worktreeSettledAfterDays: 0 }], true],
      ["mixed across machines", [{}, { worktreeOnDelete: true }], true],
    ])(
      "shows the Linux copy switch after the rules only when one deletes: %s",
      (_, rules, shown) => {
        mocks.targets = rules.map((rule, index) =>
          withSettings(environment(`env-${index}`, `Env ${index}`), { ...noRules, ...rule }),
        );
        act(() => root.render(<SettingsWorktreesRouteScreen />));
        const text = container.textContent ?? "";
        expect(text.includes("Delete the Linux copy too")).toBe(shown);
        if (shown)
          expect(text.indexOf("Delete the Linux copy too")).toBeGreaterThan(
            text.indexOf("Delete settled worktrees"),
          );
      },
    );

    it("shows mixed values when machines differ", () => {
      mocks.targets = [
        withSettings(environment("local", "Local"), { worktreeMerged: "off" }),
        withSettings(environment("remote", "Remote"), {
          worktreeMerged: "right-away",
          worktreeOnDelete: true,
          worktreeKeepWhen: "any-local-files",
        }),
      ];
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      expect(
        [...container.querySelectorAll('[role="radio"]')].some(
          (node) => node.getAttribute("aria-checked") === "true" && node.textContent === "Off",
        ),
      ).toBe(false);
      expect(toggle("Delete worktrees with deleted threads").getAttribute("aria-checked")).toBe(
        "mixed",
      );
      expect(radio("Any local files").getAttribute("aria-checked")).toBe("false");
    });

    it("hides what a selected machine cannot do and says so", () => {
      const old = environment("old", "Old");
      old.serverConfig.environment.capabilities = {
        ...old.serverConfig.environment.capabilities,
        mergedWorktreeCleanup: false,
        settledWorktreeCleanup: false,
      };
      mocks.targets = [environment("local", "Local"), old];
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      expect(container.textContent).toContain(
        "Update the selected machines to change merged worktree cleanup.",
      );
      expect(container.textContent).not.toContain("Delete the Linux copy too");
      expect(container.textContent).not.toContain("Delete settled worktrees");
      act(() => root.unmount());

      old.serverConfig.environment.capabilities.projectWorktreeCleanup = false;
      mocks.projectSelected = true;
      root = createRoot(container);
      act(() => root.render(<SettingsWorktreesRouteScreen />));
      expect(container.textContent).toContain(
        "Update the selected machines to configure project worktree cleanup.",
      );
    });
  });
});
