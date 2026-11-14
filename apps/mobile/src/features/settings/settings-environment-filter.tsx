import type { EnvironmentId } from "@t3tools/contracts";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { readProjects, useProjects } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  selectedProjectGroupsOf,
  toggleSettingsEnvironment,
  toggleSettingsProject,
} from "./settings-environment-filter.logic";

export type SettingsTarget = EnvironmentPresentation & {
  readonly serverConfig: NonNullable<EnvironmentPresentation["serverConfig"]>;
};

// Several mounted Settings components read the scope at once (the list, its header, a page and
// its editor), so share the derived lists across them for the same inputs.
const targetsCache = new WeakMap<readonly EnvironmentPresentation[], readonly SettingsTarget[]>();
const groupsCache = new WeakMap<object, Map<string, ReturnType<typeof buildProjectGroups>>>();

export function connectedSettingsTargets(environments: readonly EnvironmentPresentation[]) {
  let targets = targetsCache.get(environments);
  if (!targets) {
    targets = environments.filter(
      (entry): entry is SettingsTarget =>
        entry.connection.phase === "connected" && entry.serverConfig !== null,
    );
    targetsCache.set(environments, targets);
  }
  return targets;
}

function settingsProjectGroups(
  projects: Parameters<typeof buildProjectGroups>[0]["projects"],
  groupingMode: Parameters<typeof buildProjectGroups>[0]["settings"]["sidebarProjectGroupingMode"],
) {
  let byMode = groupsCache.get(projects);
  if (!byMode) groupsCache.set(projects, (byMode = new Map()));
  let groups = byMode.get(groupingMode);
  if (!groups) {
    groups = buildProjectGroups({
      projects,
      settings: { sidebarProjectGroupingMode: groupingMode, sidebarProjectGroupingOverrides: {} },
    });
    byMode.set(groupingMode, groups);
  }
  return groups;
}

interface SettingsEnvironmentSelection {
  readonly selectedIds: ReadonlySet<EnvironmentId> | null;
  /** `null` selects every project. */
  readonly selectedProjectKeys: ReadonlySet<string> | null;
  readonly setSelectedIds: Dispatch<SetStateAction<ReadonlySet<EnvironmentId> | null>>;
  readonly toggleProject: (projectKey: string) => void;
  readonly selectAllProjects: () => void;
  /** The selection as of now, for async work that outlives the render it started in. */
  readonly getSelectedProjectKeys: () => ReadonlySet<string> | null;
}

const SettingsEnvironmentSelectionContext = createContext<SettingsEnvironmentSelection | null>(
  null,
);

/**
 * Holds the Settings scope selection across Settings pages, which are separate root routes.
 * It stays mounted for the whole app, so it keeps only the selection; the environment and
 * project data is derived in the hook, by the Settings pages that are mounted. The selection
 * resets when Settings closes.
 */
export function SettingsEnvironmentFilterProvider(props: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [selectedProjectKeys, setSelectedProjectKeys] = useState<ReadonlySet<string> | null>(null);
  // Written only by the project setters, so it can keep keys that the close reset below cleared.
  // Its one reader, a project removal that finishes after Settings closed, then clears an
  // already empty selection, which is harmless.
  const currentProjectKeys = useRef<ReadonlySet<string> | null>(null);
  if (!props.open && (selectedIds !== null || selectedProjectKeys !== null)) {
    setSelectedIds(null);
    setSelectedProjectKeys(null);
  }
  const writeProjectKeys = (next: ReadonlySet<string> | null) => {
    currentProjectKeys.current = next;
    setSelectedProjectKeys(next);
  };
  const value = {
    selectedIds,
    selectedProjectKeys,
    setSelectedIds,
    toggleProject: (projectKey: string) =>
      writeProjectKeys(toggleSettingsProject(currentProjectKeys.current, projectKey)),
    selectAllProjects: () => writeProjectKeys(null),
    getSelectedProjectKeys: () => currentProjectKeys.current,
  };
  return (
    <SettingsEnvironmentSelectionContext value={value}>
      {props.children}
    </SettingsEnvironmentSelectionContext>
  );
}

export function useSettingsEnvironmentFilter() {
  const selection = useContext(SettingsEnvironmentSelectionContext);
  if (selection === null) throw new Error("Settings environment filter provider is missing.");
  const {
    selectedIds,
    selectedProjectKeys,
    setSelectedIds,
    toggleProject,
    selectAllProjects,
    getSelectedProjectKeys,
  } = selection;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const groupingSettings = useMobileProjectGroupingSettings();
  const groupingMode = groupingSettings.sidebarProjectGroupingMode;
  const projectGroups = settingsProjectGroups(projects, groupingMode);
  const availableTargets = connectedSettingsTargets(environments);
  const selectedTargets = useMemo(
    () =>
      availableTargets.filter(
        (entry) => selectedIds === null || selectedIds.has(entry.environmentId),
      ),
    [availableTargets, selectedIds],
  );
  const selectableProjectGroups = useMemo(
    () =>
      projectGroups.filter((group) =>
        group.members.some((member) =>
          selectedTargets.some((target) => target.environmentId === member.project.environmentId),
        ),
      ),
    [projectGroups, selectedTargets],
  );
  const selectedProjectGroups = selectedProjectGroupsOf(projectGroups, selectedProjectKeys);
  const selectedProjects = useMemo(
    () =>
      selectedProjectGroups === null
        ? null
        : selectedProjectGroups.flatMap((group) => group.members.map((member) => member.project)),
    [selectedProjectGroups],
  );
  return useMemo(
    () => ({
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKeys,
      selectedProjectGroups,
      selectedProjects,
      toggleProject,
      selectAllProjects,
      getSelectedProjectKeys,
      readProjectGroups: () => settingsProjectGroups(readProjects(), groupingMode),
      selectAll: () => setSelectedIds(null),
      toggleEnvironment: (environmentId: EnvironmentId) =>
        setSelectedIds((current) =>
          toggleSettingsEnvironment(current, availableTargets, environmentId),
        ),
    }),
    [
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      groupingMode,
      selectableProjectGroups,
      selectedProjectKeys,
      selectedProjectGroups,
      selectedProjects,
      setSelectedIds,
      toggleProject,
      selectAllProjects,
      getSelectedProjectKeys,
    ],
  );
}
