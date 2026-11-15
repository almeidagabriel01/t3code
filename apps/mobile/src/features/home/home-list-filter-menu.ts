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

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
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
