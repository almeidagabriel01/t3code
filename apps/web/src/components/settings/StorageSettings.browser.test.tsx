import { act, fakeTimers, render } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as Array<{
    environmentId: string;
    settings: typeof DEFAULT_SERVER_SETTINGS;
    sources?: Record<string, string>;
  }>,
  run: vi.fn(),
  update: vi.fn(),
  mergedSupported: true,
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environments = state.targets.map(({ environmentId, settings }) => ({
      environmentId,
      label: environmentId,
      serverConfig: {
        settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
            mergedWorktreeCleanup: state.mergedSupported,
          },
        },
      },
    }));
    return {
      scope: { kind: "all" },
      environments,
      connectedEnvironments: environments,
      targets: state.targets.map((target) => ({ sources: {}, ...target })),
      target: null,
      search: {},
      groups: [],
      selectScope: () => {},
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status && (
        <div
          data-testid={`${title === "Delete old browser artifacts" ? "artifact" : "logs"}-retention-status`}
        >
          {status}
        </div>
      )}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { StorageCleanupSections, WorktreeCleanupSection } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeMerged: "off",
      worktreeMergedAfterDays: 7,
      worktreeRunnerCopy: true,
      worktreeOnDelete: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
      worktreeSnapshotsAfterDays: 30,
    },
    projectSettingsOverrides: {},
  };
  state.targets = ["env-a", "env-b"].map((environmentId) => ({
    environmentId,
    settings: state.settings,
  }));
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
  state.mergedSupported = true;
}

function setRetentionValues(
  artifactDays: ReadonlyArray<number | null>,
  logDays: ReadonlyArray<number | null> = artifactDays.map(() => null),
  environmentIds: readonly string[] = ["env-a", "env-b"],
) {
  state.targets = artifactDays.map((browserArtifactsAfterDays, index) => ({
    environmentId: environmentIds[index]!,
    settings: {
      ...state.settings,
      storageCleanup: {
        ...state.settings.storageCleanup,
        browserArtifactsAfterDays,
        logsAfterDays: logDays[index]!,
      },
    },
  }));
  state.settings = state.targets[0]?.settings ?? state.settings;
}

const panel = () => (
  <RegistryProvider>
    <StorageCleanupSections />
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
  await screen.unmount();

  const rules = { ...state.settings.storageCleanup, worktreeOnDelete: true };
  setRetentionValues([null]);
  state.targets[0]!.settings = {
    ...state.settings,
    projectSettingsOverrides: {
      project: { worktreeCleanup: { mode: "custom", rules } },
    } as never,
  };
  await using custom = await render(panel());
  expect(deleteButton(custom.container).disabled).toBe(false);
});

it("settles mixed retention statuses independently across selected machines", async () => {
  setup();
  using _timers = fakeTimers();
  await using screen = await render(panel());
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  await advance(300);
  setRetentionValues([8, null], [8, null]);
  await screen.rerender(panel());
  await advance(125);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(8);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  await advance(117);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(75);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await advance(117);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");

  setRetentionValues([8], [null], ["env-c"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [null, null], ["env-c", "env-d"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId("logs-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
});

it("shows how long worktree snapshots are kept before deletion", async () => {
  setup();
  await using screen = await render(panel());

  await expect
    .element(screen.getByLabelText("Delete old worktree snapshots in days"))
    .toHaveValue("30");
});

it("chooses when merged worktrees are deleted and refuses days out of range", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: {
      ...state.settings.storageCleanup,
      worktreeMerged: "after-days",
      worktreeMergedAfterDays: 7,
    },
  };
  state.targets = [{ environmentId: "env-a", settings: state.settings }];
  await using screen = await render(
    <RegistryProvider>
      <WorktreeCleanupSection />
    </RegistryProvider>,
  );
  const element = (locator: { element: () => Element }) => locator.element() as HTMLElement;
  const merged = screen.getByRole("radiogroup", { name: "Delete merged worktrees" });

  await act(async () => element(merged.getByText("Right away")).click());
  expect(state.update).toHaveBeenLastCalledWith({
    storageCleanup: { worktreeMerged: "right-away" },
  });

  const days = screen.getByLabelText("Days unused before deleting a merged worktree");
  await expect.element(days).toHaveValue("7");
  await days.fill("400");
  await act(async () => element(days).blur());
  await expect.element(screen.getByRole("alert")).toBeInTheDocument();
  expect(element(screen.getByRole("alert")).textContent).toBe(
    "Enter a whole number of days from 1 to 365.",
  );
  expect(state.update).not.toHaveBeenCalledWith({
    storageCleanup: { worktreeMergedAfterDays: 400 },
  });
  await days.fill("30");
  await act(async () => element(days).blur());
  expect(state.update).toHaveBeenCalledWith({ storageCleanup: { worktreeMergedAfterDays: 30 } });
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();

  await act(async () =>
    element(screen.getByRole("switch", { name: "Delete the Linux copy too" })).click(),
  );
  expect(state.update).toHaveBeenLastCalledWith({
    storageCleanup: { worktreeRunnerCopy: false },
  });
});

const noRules = {
  worktreeOnDelete: false,
  worktreeMerged: "off",
  worktreeAfterDays: null,
  worktreeSettledAfterDays: null,
} as const;
it.each([
  ["every rule off", [{}], false],
  ["deleted threads", [{ worktreeOnDelete: true }], true],
  ["merged", [{ worktreeMerged: "right-away" }], true],
  ["inactive", [{ worktreeAfterDays: 8 }], true],
  ["settled", [{ worktreeSettledAfterDays: 0 }], true],
  ["mixed across machines", [{}, { worktreeOnDelete: true }], true],
] as const)(
  "shows the Linux copy switch after the rules only when one deletes: %s",
  async (_, rules, shown) => {
    setup();
    state.targets = rules.map((rule, index) => ({
      environmentId: `env-${index}`,
      settings: {
        ...state.settings,
        storageCleanup: { ...state.settings.storageCleanup, ...noRules, ...rule },
      },
    }));
    state.settings = state.targets[0]!.settings;
    await using screen = await render(
      <RegistryProvider>
        <WorktreeCleanupSection />
      </RegistryProvider>,
    );
    const text = () => screen.container.textContent ?? "";
    await expect.element(screen.getByText("Delete inactive worktrees").first()).toBeInTheDocument();
    expect(text().includes("Delete the Linux copy too")).toBe(shown);
    if (shown)
      expect(text().indexOf("Delete the Linux copy too")).toBeGreaterThan(
        text().indexOf("Delete inactive worktrees"),
      );
  },
);

it("asks to update machines that predate the merged worktree rule", async () => {
  setup();
  state.mergedSupported = false;
  await using screen = await render(
    <RegistryProvider>
      <WorktreeCleanupSection />
    </RegistryProvider>,
  );

  await expect
    .element(screen.getByText("Update the selected machines to change merged worktree cleanup."))
    .toBeInTheDocument();
  expect(screen.container.querySelector('[role="radiogroup"]')).toBeNull();
});
