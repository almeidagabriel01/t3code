import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { isAssistantHomeProject } from "@t3tools/client-runtime/state/projects";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { SearchField } from "../../components/ui/SearchField";
import { useProjects } from "../../state/entities";
import { ChoiceRow } from "./AssistantFormFields";

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Search plus a checkbox list of one environment's projects, archived ones included. */
export function ProjectMultiPickerSection(props: {
  readonly environmentId: EnvironmentId;
  readonly selected: ReadonlyArray<ProjectId>;
  readonly onChange: (next: ReadonlyArray<ProjectId>) => void;
}) {
  const { environmentId, selected, onChange } = props;
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !isAssistantHomeProject(project),
  );
  const inputRef = useRef<TextInputInstance>(null);
  const [query, setQuery] = useState("");
  const needle = fold(query.trim());
  const shown = projects.filter((project) => fold(project.title).includes(needle));
  return (
    <View className="gap-3">
      <View className="flex-row">
        <SearchField
          autoFocus={false}
          inputRef={inputRef}
          accessibilityLabel="Search projects"
          clearAccessibilityLabel="Clear search"
          placeholder="Search projects"
          value={query}
          onChangeText={setQuery}
        />
      </View>
      {shown.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          No projects match
        </Text>
      ) : (
        <ListSection>
          {shown.map((project) => (
            <ChoiceRow
              key={project.id}
              role="checkbox"
              leading={
                <ProjectFavicon
                  environmentId={environmentId}
                  projectTitle={project.title}
                  workspaceRoot={project.workspaceRoot}
                  faviconPath={project.faviconPath}
                  projectIcon={project.projectIcon}
                  size={24}
                />
              }
              label={project.title}
              description={project.archivedAt == null ? undefined : "Archived"}
              selected={selected.includes(project.id)}
              onPress={() =>
                onChange(
                  selected.includes(project.id)
                    ? selected.filter((id) => id !== project.id)
                    : [...selected, project.id],
                )
              }
            />
          ))}
        </ListSection>
      )}
    </View>
  );
}
