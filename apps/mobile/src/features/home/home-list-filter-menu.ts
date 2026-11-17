import type { EnvironmentId } from "@t3tools/contracts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
  /** A thread in the project needs the user; shown as a dot after the label. */
  readonly needsAttention?: boolean;
  /** Named under a shared label, so same-named projects on different machines read apart. */
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
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
  return (project: {
    readonly label: string;
    readonly environmentIds?: ReadonlyArray<EnvironmentId>;
  }): string | undefined => {
    if (!shared.has(project.label)) return undefined;
    const names = new Set(
      (project.environmentIds ?? []).flatMap(
        (id) => environments.find((environment) => environment.environmentId === id)?.label ?? [],
      ),
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
