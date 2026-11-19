import * as Equal from "effect/Equal";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SettingsRow } from "./components/SettingsRow";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import {
  type ServerSettings,
  type ServerSettingsPatch,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectScopedServerSettingKey,
} from "@t3tools/contracts";
import {
  RUNNER_SETTING_DEFAULTS,
  RUNNER_SETTING_PROJECT_KEYS,
} from "@t3tools/client-runtime/state/runnerModel";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  RUNTIME_MODE_CHOICES,
  withManagedRuntimeModeLimits,
} from "../threads/thread-settings-options";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { BranchNamingSettings } from "./components/BranchNamingSettings";
import { DatabaseStorageNotice } from "./components/DatabaseStorageNotice";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SourceControlSignInSection } from "./components/SourceControlSignInSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { settingsProjectsLabel } from "./settings-environment-filter.logic";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  managedSettingReason,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { AutoSettleSettingsRows } from "./ThreadSettingsSections";
import { KeepAwakeSection } from "./components/KeepAwakeSection";
import { HeavyNoticesSection } from "./components/HeavyNoticesSection";
import { HeavyQueueSection } from "./components/HeavyQueueSection";
import { RunnerSection } from "./components/RunnerSection";
import { WorktreeCleanupSections } from "./components/WorktreeCleanupSections";
import {
  ProviderIdleTimeoutSection,
  ToolOutputHistorySection,
} from "./components/ServerRetentionSections";
import { WorktreeSnapshotsSection } from "./components/WorktreeSnapshotsSection";
import { FallbackModelsSection } from "./components/FallbackModelsSection";
import { FolderModelsSection } from "./components/FolderModelsSection";
import { ProjectModelSections } from "./components/ProjectModelSections";
import { sameFallbackModels } from "@t3tools/shared/serverSettings";
import { fallbackModelSelectionsOf } from "@t3tools/shared/usageLimits";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import {
  CONNECT_ENVIRONMENT_FOR_MAINTENANCE_SETTINGS,
  CONNECT_ENVIRONMENT_FOR_SOURCE_CONTROL_SETTINGS,
  CONNECT_ENVIRONMENT_FOR_THREAD_SETTINGS,
  CONNECT_ENVIRONMENT_FOR_WORKTREE_SETTINGS,
  emptyEnvironmentSelectionText,
} from "@t3tools/client-runtime/settings-empty-selection";
import {
  SERVER_SETTINGS_COPY,
  STREAMING_CHOICES,
  SUBMODULE_CHOICES,
  WORKSPACE_CHOICES,
} from "./serverSettingsCopy";

type SettingsPage = "threads" | "source-control" | "worktrees" | "maintenance";

const PAGE_TITLES: Record<SettingsPage, string> = {
  threads: "Threads",
  "source-control": "Source control",
  worktrees: "Worktrees",
  maintenance: "Maintenance",
};

const CONNECT_ENVIRONMENT: Record<SettingsPage, string> = {
  threads: CONNECT_ENVIRONMENT_FOR_THREAD_SETTINGS,
  "source-control": CONNECT_ENVIRONMENT_FOR_SOURCE_CONTROL_SETTINGS,
  worktrees: CONNECT_ENVIRONMENT_FOR_WORKTREE_SETTINGS,
  maintenance: CONNECT_ENVIRONMENT_FOR_MAINTENANCE_SETTINGS,
};

const PAGE_PROJECT_KEYS: Record<SettingsPage, readonly ProjectScopedServerSettingKey[]> = {
  threads: [
    "defaultModelSelection",
    "defaultThreadEnvMode",
    "defaultRuntimeMode",
    "responseStreamingMode",
    "enableAgentBrowserAccess",
    "sidebarAutoSettleOnMerge",
    "sidebarAutoSettleAfterDays",
  ],
  "source-control": ["defaultAutoPull", "removeAgentCreditsOnMerge"],
  worktrees: [
    "worktreeCleanup",
    "newWorktreesStartFromOrigin",
    "worktreeSubmodules",
    "branchNamingMode",
    "branchNamePrefix",
    "branchNameInstructions",
  ],
  maintenance: [
    "continueThreadsAfterServerUpdate",
    "detectProblems",
    ...RUNNER_SETTING_PROJECT_KEYS,
  ],
};

// Only servers with thread auto-settlement store these, so other targets get the rest of a patch.
const AUTO_SETTLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "sidebarAutoSettleOnMerge",
  "sidebarAutoSettleAfterDays",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
]);

function planServerSettingsWrites(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  const capable = targets.filter((target) => supportsSharedSettingsSync(target.environment));
  const others = targets.filter((target) => !supportsSharedSettingsSync(target.environment));
  const othersPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !AUTO_SETTLE_SETTING_KEYS.has(key)),
  ) as ServerSettingsPatch;
  return [
    ...planMobileScopedSettingsPatch(capable, projectSelected, patch),
    ...(Object.keys(othersPatch).length > 0
      ? planMobileScopedSettingsPatch(others, projectSelected, othersPatch)
      : []),
  ];
}

/** Set by a link from a project's menu: one of its checkouts, which Settings scopes to. */
export type SettingsThreadsParams = {
  readonly environmentId?: string;
  readonly projectId?: string;
};

export function SettingsThreadsRouteScreen({
  route,
}: StaticScreenProps<SettingsThreadsParams | undefined>) {
  return <ServerSettingsDetail page="threads" linkedProject={route.params} />;
}

export function SettingsEnvironmentSourceControlRouteScreen() {
  return <ServerSettingsDetail page="source-control" />;
}

export function SettingsWorktreesRouteScreen() {
  return <ServerSettingsDetail page="worktrees" />;
}

export function SettingsEnvironmentMaintenanceRouteScreen() {
  return <ServerSettingsDetail page="maintenance" />;
}

function ServerSettingsDetail(props: {
  readonly page: SettingsPage;
  readonly linkedProject?: SettingsThreadsParams | undefined;
}) {
  const environmentMenu = useSettingsEnvironmentMenu();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {
    availableTargets,
    selectedTargets,
    selectedProjects,
    selectedProjectGroups,
    projectGroups,
    selectAll,
    selectAllProjects,
    toggleProject,
  } = useSettingsEnvironmentFilter();
  const linked = props.linkedProject;
  const linkedProjectKey = projectGroups.find((group) =>
    group.members.some(
      (member) =>
        member.project.environmentId === linked?.environmentId &&
        member.project.id === linked.projectId,
    ),
  )?.key;
  const appliedLink = useRef<string | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the Settings scope lives in a provider that clears it while Settings is closed, so a link scopes it once the page is open
  useEffect(() => {
    if (linkedProjectKey === undefined || appliedLink.current === linkedProjectKey) return;
    appliedLink.current = linkedProjectKey;
    selectAll();
    selectAllProjects();
    toggleProject(linkedProjectKey);
  }, [linkedProjectKey, selectAll, selectAllProjects, toggleProject]);
  const projectSelected = selectedProjects !== null;
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const targets = resolveMobileSettingsTargets(selectedTargets, selectedProjects);
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  // Closing views can save after controls disable; queue those patches behind the pending write.
  const queuedPatch = useRef<{ key: string; patch: ServerSettingsPatch } | null>(null);
  const targetsKey = targets
    .map((target) => `${target.environment.environmentId}:${target.projectId}`)
    .join(",");
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const canWriteSettings =
    targets.length > 0 &&
    targets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets = pendingWrites > 0 && pendingTargets !== null ? pendingTargets : targets;
  const hasConnectedSelection = targets.length > 0;
  const reference = displayTargets[0] ?? null;
  const uniform = <K extends keyof ServerSettings>(key: K) =>
    uniformMobileSetting(displayTargets, key);
  // `uniform` folds a real null into "mixed"; nullable keys need the distinction.
  const isMixed = (key: keyof ServerSettings) =>
    reference === null ||
    displayTargets.some((entry) => entry.settings[key] !== reference.settings[key]);
  const writeSettings = useSettingsWriter();
  const write = (patch: ServerSettingsPatch) => {
    if (writeInFlight.current) {
      const queued = queuedPatch.current;
      queuedPatch.current = {
        key: targetsKey,
        patch: queued?.key === targetsKey ? { ...queued.patch, ...patch } : patch,
      };
      return;
    }
    if (
      !hasConnectedSelection ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planServerSettingsWrites(targets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
      const queued = queuedPatch.current;
      queuedPatch.current = null;
      // These targets may not show this write yet, so send it again with the
      // queued patch; project overrides are replaced whole.
      if (queued?.key === targetsKey) write({ ...patch, ...queued.patch });
    });
  };
  const clearProjectOverrides = (
    keys: readonly ProjectScopedServerSettingKey[] = PAGE_PROJECT_KEYS[props.page],
  ) => {
    if (
      writeInFlight.current ||
      !targets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(targets, keys);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(targets);
    setPendingWrites((count) => count + 1);
    void writeSettings(targets, writes).finally(() => {
      writeInFlight.current = false;
      // Resending a draft over these pre-clear targets would undo the clear.
      queuedPatch.current = null;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };
  const disabled = !canWriteSettings || pendingWrites > 0 || !hasConnectedSelection;
  const managed = (...keys: string[]) => managedSettingReason(targets, ...keys);
  // A locked row keeps its explanation and says who manages it.
  const managedSubtitle = (key: string, subtitle: string) => {
    const reason = managed(key);
    return reason === undefined ? subtitle : `${subtitle} ${reason}`;
  };
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    RUNTIME_MODE_CHOICES,
    targets.map((target) => target.environment.serverConfig.managedPolicy),
  );
  const disabledFor = (key: string) =>
    disabled ||
    managed(key) !== undefined ||
    (projectSelected &&
      !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(
        key as (typeof PROJECT_SCOPED_SERVER_SETTING_KEYS)[number],
      ));

  return (
    <SettingsScreen title={PAGE_TITLES[props.page]} menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!hasConnectedSelection || reference === null ? (
          <Text className="px-2 text-base text-foreground-muted">
            {projectSelected
              ? "Select a project with a checkout on a connected environment."
              : emptyEnvironmentSelectionText(
                  CONNECT_ENVIRONMENT[props.page],
                  availableTargets.length > 0,
                )}
          </Text>
        ) : (
          <>
            <ManagedPolicyNotice targets={targets} />
            {projectSelected ? (
              <SettingsProjectOverridesSection
                projectLabel={settingsProjectsLabel(selectedProjectGroups)}
                hasOverrides={targets.some((target) =>
                  PAGE_PROJECT_KEYS[props.page].some((key) => target.sources[key] === "project"),
                )}
                pending={pendingWrites > 0}
                disabled={!canWriteSettings}
                onClear={() => clearProjectOverrides()}
              />
            ) : null}
            {props.page === "threads" ? (
              <>
                {projectSelected ? (
                  <ProjectModelSections
                    targets={displayTargets}
                    disabled={disabled || managed("defaultModelSelection") !== undefined}
                    showAssistants={selectedProjectGroups?.length === 1}
                    onReset={() => clearProjectOverrides(["defaultModelSelection"])}
                  />
                ) : null}
                <SettingsSection
                  title={SERVER_SETTINGS_COPY.defaultWorkspace.title}
                  footer={managed("defaultThreadEnvMode")}
                  trailing={
                    pendingWrites === 0 && isMixed("defaultThreadEnvMode") ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {WORKSPACE_CHOICES.filter(
                    (choice) => choice.mode !== null || !projectSelected,
                  ).map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode ?? "inherit"}
                      label={choice.label}
                      description={choice.description}
                      selected={
                        !isMixed("defaultThreadEnvMode") &&
                        uniform("defaultThreadEnvMode") === choice.mode
                      }
                      separated={index > 0}
                      disabled={disabledFor("defaultThreadEnvMode")}
                      onPress={() => write({ defaultThreadEnvMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection
                  title={SERVER_SETTINGS_COPY.defaultPermissions.title}
                  footer={managed("defaultRuntimeMode")}
                  trailing={
                    pendingWrites === 0 && uniform("defaultRuntimeMode") === null ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {runtimeModeChoices.map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode}
                      label={choice.label}
                      description={choice.disabledReason ?? choice.description}
                      selected={uniform("defaultRuntimeMode") === choice.mode}
                      separated={index > 0}
                      disabled={
                        disabledFor("defaultRuntimeMode") || choice.disabledReason !== undefined
                      }
                      onPress={() => write({ defaultRuntimeMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection
                  title={SERVER_SETTINGS_COPY.responseStreaming.title}
                  footer={managed("responseStreamingMode")}
                  trailing={
                    pendingWrites === 0 && uniform("responseStreamingMode") === null ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {STREAMING_CHOICES.map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode}
                      label={choice.label}
                      description={choice.description}
                      selected={uniform("responseStreamingMode") === choice.mode}
                      separated={index > 0}
                      disabled={disabledFor("responseStreamingMode")}
                      onPress={() => write({ responseStreamingMode: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <SettingsSection title={SERVER_SETTINGS_COPY.previewBrowser.title}>
                  <SettingsSwitchRow
                    icon="globe"
                    label={SERVER_SETTINGS_COPY.agentBrowserAccess.title}
                    subtitle={managedSubtitle(
                      "enableAgentBrowserAccess",
                      SERVER_SETTINGS_COPY.agentBrowserAccess.description,
                    )}
                    value={uniform("enableAgentBrowserAccess")}
                    disabled={disabledFor("enableAgentBrowserAccess")}
                    onValueChange={(value) => write({ enableAgentBrowserAccess: value })}
                  />
                </SettingsSection>
                {!projectSelected ? (
                  <FallbackModelsSection
                    environmentId={reference.environment.environmentId}
                    chain={fallbackModelSelectionsOf(reference.settings)}
                    editable={!disabled && displayTargets.length === 1}
                    mixed={displayTargets.some(
                      (entry) =>
                        !sameFallbackModels(
                          fallbackModelSelectionsOf(entry.settings),
                          fallbackModelSelectionsOf(reference.settings),
                        ),
                    )}
                    write={write}
                  />
                ) : null}
                {!projectSelected ? (
                  <FolderModelsSection
                    environmentId={reference.environment.environmentId}
                    rules={reference.settings.folderModelDefaults}
                    editable={!disabled && displayTargets.length === 1}
                    mixed={displayTargets.some(
                      (entry) =>
                        !Equal.equals(
                          entry.settings.folderModelDefaults,
                          reference.settings.folderModelDefaults,
                        ),
                    )}
                    write={write}
                  />
                ) : null}
                <AutoSettleSettingsRows write={write} pending={pendingWrites > 0} />
              </>
            ) : null}

            {props.page === "source-control" ? (
              <>
                {projectSelected ? null : (
                  <SourceControlSignInSection
                    environments={selectedTargets}
                    canWrite={(environmentId) => writableEnvironments.has(environmentId)}
                  />
                )}
                <SettingsSection title={SERVER_SETTINGS_COPY.pullRequests.title}>
                  <SettingsSwitchRow
                    icon={PullRequestGlyph.merged}
                    label={SERVER_SETTINGS_COPY.removeAgentCredits.title}
                    subtitle={managedSubtitle(
                      "removeAgentCreditsOnMerge",
                      SERVER_SETTINGS_COPY.removeAgentCredits.description,
                    )}
                    value={uniform("removeAgentCreditsOnMerge")}
                    disabled={disabledFor("removeAgentCreditsOnMerge")}
                    onValueChange={(value) => write({ removeAgentCreditsOnMerge: value })}
                  />
                </SettingsSection>
                <SettingsSection title={SERVER_SETTINGS_COPY.defaultBranch.title}>
                  <SettingsSwitchRow
                    icon="arrow.down.circle"
                    label={SERVER_SETTINGS_COPY.autoPull.title}
                    subtitle={managedSubtitle(
                      "defaultAutoPull",
                      SERVER_SETTINGS_COPY.autoPull.description,
                    )}
                    value={uniform("defaultAutoPull")}
                    disabled={disabledFor("defaultAutoPull")}
                    onValueChange={(value) => write({ defaultAutoPull: value })}
                  />
                </SettingsSection>
                <SettingsSection title={SERVER_SETTINGS_COPY.clones.title}>
                  <SettingsSwitchRow
                    icon="folder"
                    label={SERVER_SETTINGS_COPY.hostFolders.title}
                    subtitle={SERVER_SETTINGS_COPY.hostFolders.description}
                    value={uniform("ghqCloneLayout")}
                    disabled={disabledFor("ghqCloneLayout")}
                    onValueChange={(value) => write({ ghqCloneLayout: value })}
                  />
                </SettingsSection>
              </>
            ) : null}

            {props.page === "worktrees" ? (
              <>
                <SettingsSection title={SERVER_SETTINGS_COPY.newWorktrees.title}>
                  <SettingsSwitchRow
                    icon="arrow.triangle.branch"
                    label={SERVER_SETTINGS_COPY.startFromRemote.title}
                    subtitle={managedSubtitle(
                      "newWorktreesStartFromOrigin",
                      SERVER_SETTINGS_COPY.startFromRemote.description,
                    )}
                    value={uniform("newWorktreesStartFromOrigin")}
                    disabled={disabledFor("newWorktreesStartFromOrigin")}
                    onValueChange={(value) => write({ newWorktreesStartFromOrigin: value })}
                  />
                </SettingsSection>
                <SettingsSection
                  title={SERVER_SETTINGS_COPY.worktreeSubmodules.title}
                  footer={managed("worktreeSubmodules")}
                  trailing={
                    pendingWrites === 0 && isMixed("worktreeSubmodules") ? (
                      <MixedValuesLabel projectSelected={projectSelected} />
                    ) : null
                  }
                >
                  {SUBMODULE_CHOICES.filter(
                    (choice) => choice.mode !== null || !projectSelected,
                  ).map((choice, index) => (
                    <SettingsChoiceRow
                      key={choice.mode ?? "inherit"}
                      label={choice.label}
                      description={choice.description}
                      selected={
                        !isMixed("worktreeSubmodules") &&
                        uniform("worktreeSubmodules") === choice.mode
                      }
                      separated={index > 0}
                      disabled={disabledFor("worktreeSubmodules")}
                      onPress={() => write({ worktreeSubmodules: choice.mode })}
                    />
                  ))}
                </SettingsSection>
                <BranchNamingSettings
                  key={targetsKey}
                  mode={uniform("branchNamingMode")}
                  prefix={uniform("branchNamePrefix")}
                  instructions={uniform("branchNameInstructions")}
                  disabled={{
                    mode: disabledFor("branchNamingMode"),
                    prefix: disabledFor("branchNamePrefix"),
                    instructions: disabledFor("branchNameInstructions"),
                  }}
                  onChange={write}
                />
                <WorktreeCleanupSections
                  targets={displayTargets}
                  projectSelected={projectSelected}
                  disabledFor={disabledFor}
                  managed={managed}
                  write={write}
                  clearProjectCleanup={() => clearProjectOverrides(["worktreeCleanup"])}
                />
              </>
            ) : null}

            {props.page === "maintenance" ? (
              <>
                {!projectSelected ? (
                  <DatabaseStorageNotice
                    targets={selectedTargets.filter(
                      (target) =>
                        target.serverConfig.environment.capabilities.databaseStorage === true,
                    )}
                  />
                ) : null}
                {!projectSelected ? (
                  <SettingsSection title={SERVER_SETTINGS_COPY.manageEnvironments.title}>
                    {selectedTargets.map((target) => (
                      <SettingsRow
                        key={target.environmentId}
                        icon="server.rack"
                        label={target.label}
                        value={SERVER_SETTINGS_COPY.manageEnvironments.description}
                        onPress={() =>
                          navigation.navigate("SettingsEnvironmentDetail", {
                            environmentId: target.environmentId,
                          })
                        }
                      />
                    ))}
                  </SettingsSection>
                ) : null}
                {!projectSelected ? (
                  <KeepAwakeSection
                    environmentId={reference.environment.environmentId}
                    value={isMixed("keepAwake") ? null : uniform("keepAwake")}
                    disabled={disabledFor("keepAwake")}
                    onChange={(mode) => write({ keepAwake: mode })}
                  />
                ) : null}
                {!projectSelected ? (
                  <SettingsSection>
                    <SettingsRow
                      icon="gauge.with.dots.needle.50percent"
                      label={SERVER_SETTINGS_COPY.resourceManager.title}
                      target="SettingsResourceManager"
                    />
                  </SettingsSection>
                ) : null}
                {/* Each machine has its own queue, so several environments get one section each. */}
                {!projectSelected
                  ? displayTargets.map((target) => {
                      const machine =
                        displayTargets.length > 1 ? target.environment.label : undefined;
                      return (
                        <HeavyQueueSection
                          key={target.environment.environmentId}
                          environmentId={target.environment.environmentId}
                          {...(machine === undefined ? {} : { machine })}
                          runner={{
                            enabled: target.settings.runnerEnabled,
                            where: target.settings.runnerWhere,
                            everything:
                              target.settings.runnerLinuxEverything ??
                              RUNNER_SETTING_DEFAULTS.runnerLinuxEverything,
                          }}
                          slowAgentJobs={{
                            value: target.settings.heavySlowAgentJobs,
                            disabled: disabledFor("heavySlowAgentJobs"),
                            onChange: (value) => write({ heavySlowAgentJobs: value }),
                          }}
                        />
                      );
                    })
                  : null}
                {!projectSelected ? (
                  <HeavyNoticesSection
                    value={isMixed("heavyNotices") ? null : uniform("heavyNotices")}
                    disabled={disabledFor("heavyNotices")}
                    onChange={(mode) => write({ heavyNotices: mode })}
                  />
                ) : null}
                <RunnerSection
                  environmentId={reference.environment.environmentId}
                  settings={reference.settings}
                  projectSelected={projectSelected}
                  overridden={(key) =>
                    displayTargets.some((target) => target.sources[key] === "project")
                  }
                  mixed={(key) =>
                    displayTargets.some(
                      (target) =>
                        JSON.stringify(target.settings[key]) !==
                        JSON.stringify(reference.settings[key]),
                    )
                  }
                  disabledFor={disabledFor}
                  write={write}
                  reset={(key) => clearProjectOverrides([key])}
                  severalMachines={
                    new Set(displayTargets.map((target) => target.environment.environmentId)).size >
                    1
                  }
                />
                {!projectSelected ? (
                  <WorktreeSnapshotsSection
                    value={
                      displayTargets.every(
                        (target) =>
                          target.settings.storageCleanup.worktreeSnapshotsAfterDays ===
                          reference.settings.storageCleanup.worktreeSnapshotsAfterDays,
                      )
                        ? reference.settings.storageCleanup.worktreeSnapshotsAfterDays
                        : undefined
                    }
                    disabled={disabledFor("storageCleanup.worktreeSnapshotsAfterDays")}
                    onChange={(days) =>
                      write({ storageCleanup: { worktreeSnapshotsAfterDays: days } })
                    }
                  />
                ) : null}
                {!projectSelected ? (
                  <>
                    <ToolOutputHistorySection
                      days={reference.settings.toolOutputHistoryDays}
                      disabled={disabledFor("toolOutputHistoryDays")}
                      onChange={(days) => write({ toolOutputHistoryDays: days })}
                    />
                    <ProviderIdleTimeoutSection
                      minutes={reference.settings.providerIdleTimeoutMinutes}
                      disabled={disabledFor("providerIdleTimeoutMinutes")}
                      onChange={(minutes) => write({ providerIdleTimeoutMinutes: minutes })}
                    />
                  </>
                ) : null}
                <SettingsSection title={SERVER_SETTINGS_COPY.updates.title}>
                  <SettingsSwitchRow
                    icon="arrow.clockwise"
                    label={SERVER_SETTINGS_COPY.providerUpdates.title}
                    subtitle={managedSubtitle(
                      "enableProviderUpdateChecks",
                      projectSelected
                        ? SERVER_SETTINGS_COPY.providerUpdates.projectDescription
                        : SERVER_SETTINGS_COPY.providerUpdates.description,
                    )}
                    value={uniform("enableProviderUpdateChecks")}
                    disabled={disabledFor("enableProviderUpdateChecks")}
                    onValueChange={(value) => write({ enableProviderUpdateChecks: value })}
                  />
                  <View className="border-t border-border-subtle">
                    <SettingsSwitchRow
                      icon="arrow.uturn.forward"
                      label={SERVER_SETTINGS_COPY.continueAfterRestart.title}
                      subtitle={managedSubtitle(
                        "continueThreadsAfterServerUpdate",
                        SERVER_SETTINGS_COPY.continueAfterRestart.description,
                      )}
                      value={uniform("continueThreadsAfterServerUpdate")}
                      disabled={disabledFor("continueThreadsAfterServerUpdate")}
                      onValueChange={(value) => write({ continueThreadsAfterServerUpdate: value })}
                    />
                  </View>
                </SettingsSection>
                <SettingsSection title={SERVER_SETTINGS_COPY.diagnostics.title}>
                  <SettingsSwitchRow
                    icon="exclamationmark.shield"
                    label={
                      projectSelected
                        ? SERVER_SETTINGS_COPY.detectProblems.projectTitle
                        : SERVER_SETTINGS_COPY.detectProblems.title
                    }
                    subtitle={
                      projectSelected
                        ? managed("detectProblems")
                        : managedSubtitle(
                            "detectProblems",
                            SERVER_SETTINGS_COPY.detectProblems.description,
                          )
                    }
                    value={uniform("detectProblems")}
                    disabled={disabledFor("detectProblems")}
                    onValueChange={(value) => write({ detectProblems: value })}
                  />
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function MixedValuesLabel(props: { readonly projectSelected: boolean }) {
  return (
    <Text
      accessibilityLabel={
        props.projectSelected
          ? "Selected project checkouts use different values"
          : "Selected environments use different values"
      }
      className="px-2 text-sm text-foreground-muted android:px-4"
    >
      Mixed
    </Text>
  );
}

/** Locked settings are refused when saved; say so before the user tries. */
function ManagedPolicyNotice(props: { readonly targets: readonly ScopedMobileSettingsTarget[] }) {
  const organizations = [
    ...new Set(
      props.targets.flatMap((target) => {
        const policy = target.environment.serverConfig.managedPolicy;
        return policy !== undefined && policy.lockedSettings.length > 0
          ? [policy.organization]
          : [];
      }),
    ),
  ];
  if (organizations.length === 0) return null;
  return (
    <Text className="px-2 text-sm text-foreground-muted android:px-4">
      Some settings are managed by {organizations.join(", ")} and cannot be changed here.
    </Text>
  );
}
