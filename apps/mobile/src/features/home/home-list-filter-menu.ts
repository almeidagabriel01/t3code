import type { EnvironmentId } from "@t3tools/contracts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl?: string | null;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
  /** A thread in the project needs the user; shown as a dot after the label. */
  readonly needsAttention?: boolean;
  /** Named under a shared label, so same-named projects on different machines read apart. */
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
}

/** Each machine's name, or its address when another environment in the list shares that name. */
export function environmentMachineNames(
  environments: ReadonlyArray<HomeListFilterMenuEnvironment>,
): ReadonlyMap<EnvironmentId, string> {
  const counts = new Map<string, number>();
  for (const { label } of environments) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(
    environments.map((environment) => [
      environment.environmentId,
      ((counts.get(environment.label) ?? 0) > 1 && environment.displayUrl) || environment.label,
    ]),
  );
}

/** The address under an environment row whose name another environment shares. */
export function sameNameEnvironmentSubtitle(
  environments: ReadonlyArray<HomeListFilterMenuEnvironment>,
) {
  const names = environmentMachineNames(environments);
  return (environment: HomeListFilterMenuEnvironment): string | undefined => {
    const name = names.get(environment.environmentId);
    return name === environment.label ? undefined : name;
  };
}

/** Names the machines of projects whose label another project in the list shares. */
export function sameNameMachineLabels(
  projects: ReadonlyArray<{ readonly label: string }>,
  environments: ReadonlyArray<HomeListFilterMenuEnvironment>,
) {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { label } of projects) {
    if (seen.has(label)) shared.add(label);
    seen.add(label);
  }
  const machineNames = environmentMachineNames(environments);
  return (project: {
    readonly label: string;
    readonly environmentIds?: ReadonlyArray<EnvironmentId>;
  }): string | undefined => {
    if (!shared.has(project.label)) return undefined;
    const names = new Set(
      (project.environmentIds ?? []).flatMap((id) => machineNames.get(id) ?? []),
    );
    return [...names].join(", ") || undefined;
  };
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  /** Set when the selected project can be archived from here. */
  readonly onArchiveProject?: (() => void) | undefined;
  readonly onOpenProjectSettings?: (() => void) | undefined;
}): AppBarMenuItem[] {
  const environmentSubtitle = sameNameEnvironmentSubtitle(props.environments);
  const items: AppBarMenuItem[] = [
    {
      id: "environment",
      title: "Environment",
      icon: "server.rack",
      items: [
        {
          id: "environment:all",
          title: "All environments",
          subtitle: "Show threads from every environment",
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          subtitle: environmentSubtitle(environment),
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  const machineOf = sameNameMachineLabels(props.projects, props.environments);

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
      icon: "folder",
      items: [
        {
          id: "project:all",
          title: "All projects",
          subtitle: "Show threads from every project",
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.needsAttention ? `${project.label} •` : project.label,
          subtitle: machineOf(project),
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  if (props.onOpenProjectSettings && selectedProject) {
    items.push({
      id: "project:settings",
      title: "Project settings",
      subtitle: selectedProject.label,
      icon: "gearshape",
      onPress: props.onOpenProjectSettings,
    });
  }
  if (props.onArchiveProject && selectedProject) {
    items.push({
      id: "project:archive",
      title: "Archive project",
      subtitle: selectedProject.label,
      icon: "archivebox",
      onPress: props.onArchiveProject,
    });
  }

  return items;
}
