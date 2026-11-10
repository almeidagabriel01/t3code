import type { EnvironmentId } from "@t3tools/contracts";

export function toggleSettingsEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  available: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = available.map((entry) => entry.environmentId);
  const next = new Set(ids.filter((id) => selected === null || selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}

export function toggleSettingsProject(
  selected: ReadonlySet<string> | null,
  projectKey: string,
): ReadonlySet<string> | null {
  const next = new Set(selected);
  if (!next.delete(projectKey)) next.add(projectKey);
  return next.size === 0 ? null : next;
}

/** `null` means every project; keys of projects that no longer exist select nothing. */
export function selectedProjectGroupsOf<G extends { readonly key: string }>(
  groups: readonly G[],
  selected: ReadonlySet<string> | null,
): readonly G[] | null {
  return selected === null ? null : groups.filter((group) => selected.has(group.key));
}

export function settingsTargetsForProject<T extends { readonly environmentId: EnvironmentId }>(
  targets: readonly T[],
  projects: readonly { readonly environmentId: EnvironmentId }[] | null,
): readonly T[] {
  if (projects === null) return targets;
  return targets.filter((target) =>
    projects.some((project) => project.environmentId === target.environmentId),
  );
}

export function settingsProjectsLabel(groups: readonly { readonly label: string }[] | null) {
  if (groups === null) return "All projects";
  if (groups.length === 0) return "Unavailable project";
  return groups.length === 1 ? groups[0]!.label : `${groups.length} projects`;
}
