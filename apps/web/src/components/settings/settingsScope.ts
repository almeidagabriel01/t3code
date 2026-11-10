import type { EnvironmentId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";

export interface SettingsScopeSearch {
  project?: string | undefined;
  machine?: string | undefined;
  checkout?: string | undefined;
}

type ScopeTargets = {
  label: string;
  members: readonly SidebarProjectGroupMember[];
  environmentIds: readonly EnvironmentId[];
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | {
        kind: "project";
        group: SidebarProjectSnapshot;
        groups: readonly SidebarProjectSnapshot[];
        environmentId: EnvironmentId | null;
      }
    | {
        kind: "checkout";
        group: SidebarProjectSnapshot;
        checkout: SidebarProjectGroupMember;
        environmentId: EnvironmentId;
      }
    | {
        kind: "unavailable";
        reason: "project-required" | "project-missing" | "environment-missing" | "checkout-missing";
        message: string;
      }
  );

/** One key stays a bare string so old links work; several are a JSON array in the same field. */
export function settingsScopeProjectKeys(
  search: Pick<SettingsScopeSearch, "project">,
): readonly string[] {
  const { project } = search;
  if (!project) return [];
  if (project.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(project);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((key) => typeof key === "string" && key.length > 0)
      ) {
        return [...new Set<string>(parsed)];
      }
    } catch {
      // A key that merely starts with "[" is a single key.
    }
  }
  return [project];
}

export function settingsScopeProjectValue(keys: readonly string[]): string | undefined {
  const unique = [...new Set(keys)];
  return unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : JSON.stringify(unique);
}

/** Stale IDs remain visible to the resolver so a removed target reads as unavailable, not as "all". */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  // A hand-written `?project=["a","b"]` reaches here already parsed as an array.
  const project = Array.isArray(raw.project)
    ? settingsScopeProjectValue(
        raw.project.filter((key): key is string => stringValue(key) !== undefined),
      )
    : stringValue(raw.project);
  const machine = stringValue(raw.machine);
  const checkout = stringValue(raw.checkout);
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
    ...(checkout === undefined ? {} : { checkout }),
  };
}

/** An unavailable selection never broadens a subsequent write. */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[],
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
  });

  if (search.checkout && settingsScopeProjectKeys(search).length === 0) {
    return unavailable("project-required", "Select a project to choose one of its checkouts.");
  }

  const environment = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !environment) {
    return unavailable("environment-missing", "This environment is no longer available.");
  }

  const projectKeys = settingsScopeProjectKeys(search);
  if (projectKeys.length > 0) {
    const selected = projectKeys.flatMap((key) => {
      const found = groups.find((candidate) => candidate.projectKey === key);
      return found ? [found] : [];
    });
    const group = selected[0];
    if (!group) {
      return unavailable(
        "project-missing",
        projectKeys.length > 1
          ? "These projects are no longer available."
          : "This project is no longer available.",
      );
    }
    const several = projectKeys.length > 1;
    const checkoutKey = several ? undefined : search.checkout;
    const members = selected
      .flatMap((candidate) => candidate.memberProjects)
      .filter(
        (member) =>
          (search.machine === undefined || member.environmentId === search.machine) &&
          (checkoutKey === undefined || member.physicalProjectKey === checkoutKey),
      );
    if (members.length === 0) {
      return unavailable(
        "checkout-missing",
        checkoutKey
          ? "This checkout is no longer available in the selected project and environment."
          : several
            ? "These projects have no checkout on this environment."
            : "This project has no checkout on this environment.",
      );
    }
    if (checkoutKey) {
      const checkout = members[0]!;
      const checkoutEnvironment = environments.find(
        (candidate) => candidate.environmentId === checkout.environmentId,
      );
      if (!checkoutEnvironment) {
        return unavailable(
          "environment-missing",
          "This checkout's environment is no longer available.",
        );
      }
      const sharesEnvironment = group.memberProjects.some(
        (member) =>
          member.environmentId === checkout.environmentId &&
          member.physicalProjectKey !== checkout.physicalProjectKey,
      );
      return {
        kind: "checkout",
        group,
        checkout,
        environmentId: checkout.environmentId,
        label: `${group.displayName} / ${checkoutEnvironment.label}${sharesEnvironment ? ` · ${checkout.workspaceRoot}` : ""}`,
        members,
        environmentIds: [checkout.environmentId],
      };
    }
    const names = selected.map((candidate) => candidate.displayName);
    return {
      kind: "project",
      group,
      groups: selected,
      environmentId: environment?.environmentId ?? null,
      label: `${names.length > 2 ? `${names.length} projects` : names.join(", ")} / ${environment?.label ?? "All checkouts"}`,
      members,
      environmentIds: [...new Set(members.map((member) => member.environmentId))],
    };
  }
  if (environment) {
    return {
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      members: [],
      environmentIds: [environment.environmentId],
    };
  }
  return {
    kind: "all",
    label: "All environments",
    members: [],
    environmentIds: environments.map((candidate) => candidate.environmentId),
  };
}
