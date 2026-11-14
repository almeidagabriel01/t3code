import { membersGainingAccess } from "@t3tools/client-runtime/assistantProjectAccess";
import type { AssistantTeam, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useAssistantEntries } from "../../state/assistants";
import { FieldHeader } from "./AssistantFormFields";
import { ProjectMultiPickerSection } from "./ProjectMultiPickerSection";

export function GroupProjectsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly value: ReadonlyArray<ProjectId>;
  readonly onChange: (next: ReadonlyArray<ProjectId>) => void;
}) {
  const { environmentId, team, value } = props;
  const entries = useAssistantEntries();
  const gaining = membersGainingAccess(
    team,
    value,
    entries.active
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.assistant),
    entries.teams
      .filter((entry) => entry.environmentId === environmentId)
      .map((entry) => entry.team),
  );
  return (
    <View className="gap-2">
      <FieldHeader
        label="Projects"
        description="Every member can work in these projects, on top of their own."
      />
      <ProjectMultiPickerSection
        environmentId={environmentId}
        selected={value}
        onChange={props.onChange}
      />
      {gaining === 0 ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {gaining === 1 ? "1 member gains access" : `${gaining} members gain access`}
        </Text>
      )}
    </View>
  );
}
