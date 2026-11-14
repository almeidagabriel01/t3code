import type { AccessAssistant } from "@t3tools/client-runtime/assistantProjectAccess";
import { inheritedProjects } from "@t3tools/client-runtime/assistantProjectAccess";
import type { AssistantTeam, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useProjects } from "../../state/entities";

/** Read-only: the projects a project-scope assistant reaches through its groups. */
export function InheritedProjectsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly assistant: AccessAssistant;
  readonly teams: ReadonlyArray<AssistantTeam>;
}) {
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const rows = inheritedProjects(props.assistant, props.teams).flatMap((inherited) => {
    const project = projects.find((entry) => entry.id === inherited.projectId);
    return project === undefined ? [] : [{ inherited, project }];
  });
  if (rows.length === 0) return null;
  return (
    <ListSection title="From groups">
      {rows.map(({ inherited, project }) => (
        <View key={project.id} className="bg-grouped-card">
          <ListRowLayout
            leading={
              <ProjectFavicon
                environmentId={props.environmentId}
                projectTitle={project.title}
                workspaceRoot={project.workspaceRoot}
                faviconPath={project.faviconPath}
                projectIcon={project.projectIcon}
                size={24}
              />
            }
            label={project.title}
            description={`via ${inherited.teamNames.join(", ")}${inherited.alsoOwn ? " · also its own" : ""}`}
          />
        </View>
      ))}
    </ListSection>
  );
}
