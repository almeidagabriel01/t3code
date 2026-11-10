import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  settingsScopeProjectKeys,
  settingsScopeProjectValue,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

export function settingsScopeEnvironmentAddress(environment: ScopeEnvironment) {
  if (!environment.displayUrl) return environment.environmentId;
  try {
    return new URL(environment.displayUrl).host || environment.displayUrl;
  } catch {
    return environment.displayUrl;
  }
}

export function settingsScopeEnvironmentLabels(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const duplicates = environments.filter(
    (other) =>
      other.environmentId !== environment.environmentId && other.label === environment.label,
  );
  const address = settingsScopeEnvironmentAddress(environment);
  const secondary = duplicates.some((other) => settingsScopeEnvironmentAddress(other) === address)
    ? environment.displayUrl || environment.environmentId
    : address;
  return {
    primary: environment.label,
    secondary: duplicates.length ? secondary : "",
  };
}

export function settingsScopeEnvironmentLabel(
  environment: ScopeEnvironment,
  environments: readonly ScopeEnvironment[],
) {
  const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
  return secondary ? `${primary} · ${secondary}` : primary;
}

export function settingsScopeProjectMachines(
  group: SidebarProjectSnapshot,
  environments: readonly ScopeEnvironment[],
  includeAddresses = false,
) {
  const machines = group.memberProjects.map((member) => {
    const environment = environments.find((entry) => entry.environmentId === member.environmentId);
    if (!environment) return member.environmentLabel ?? member.environmentId;
    const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
    const address =
      secondary || (includeAddresses ? settingsScopeEnvironmentAddress(environment) : "");
    return includeAddresses || address ? `${primary} · ${address}` : primary;
  });
  return Array.from(new Set(machines));
}

export const ALL_ENVIRONMENTS_VALUE = "all";
export const ALL_PROJECTS_VALUE = "all";

export function environmentAxisValue(
  search: SettingsScopeSearch,
  resolvedEnvironmentId?: string | null,
): string {
  return search.machine ?? resolvedEnvironmentId ?? ALL_ENVIRONMENTS_VALUE;
}

export function projectAxisValues(search: SettingsScopeSearch): readonly string[] {
  const keys = settingsScopeProjectKeys(search);
  return keys.length > 0 ? keys : [ALL_PROJECTS_VALUE];
}

export function projectScopeMenuGroups(
  groups: readonly SidebarProjectSnapshot[],
  search: Pick<SettingsScopeSearch, "machine">,
) {
  const { machine } = search;
  if (machine === undefined) return groups;
  return groups.filter((group) =>
    group.memberProjects.some((member) => member.environmentId === machine),
  );
}

export function selectEnvironmentAxis(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (search.project) next.project = search.project;
  if (value !== ALL_ENVIRONMENTS_VALUE) next.machine = value;
  return next;
}

export function selectProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (value !== ALL_PROJECTS_VALUE) next.project = value;
  if (search.machine) next.machine = search.machine;
  return next;
}

/** Adds or removes one project from the selection; "all" clears it. */
export function toggleProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  const keys = settingsScopeProjectKeys(search);
  return selectProjectKeys(
    search,
    value === ALL_PROJECTS_VALUE
      ? []
      : keys.includes(value)
        ? keys.filter((key) => key !== value)
        : [...keys, value],
  );
}

function selectProjectKeys(search: SettingsScopeSearch, keys: readonly string[]) {
  const next: SettingsScopeSearch = {};
  const project = settingsScopeProjectValue(keys);
  if (project !== undefined) next.project = project;
  if (search.machine) next.machine = search.machine;
  return next;
}

export function selectSingleEnvironmentScope(
  search: SettingsScopeSearch,
  scope: ResolvedSettingsScope,
  environments: readonly {
    readonly environmentId: EnvironmentPresentation["environmentId"];
    readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
  }[],
  primaryEnvironmentId: string | null,
): SettingsScopeSearch {
  if (search.machine || scope.kind === "unavailable") return search;
  const selectedIds = new Set(scope.environmentIds);
  const candidates = environments.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const selected =
    candidates.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    candidates.find((environment) => environment.connection.phase === "connected") ??
    candidates[0];
  return selected ? { ...search, machine: selected.environmentId } : search;
}
