import { membersGainingAccess } from "@t3tools/client-runtime/assistantProjectAccess";
import type { AssistantTeam, EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useAssistantEntries } from "../../state/assistants";
import { ProjectMultiPicker } from "./ProjectMultiPicker";

export function GroupProjectsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly team: AssistantTeam;
  readonly picked: ReadonlyArray<ProjectId>;
  readonly onChange: (next: ReadonlyArray<ProjectId>) => void;
}) {
  const { active, teams } = useAssistantEntries();
  const gaining = membersGainingAccess(
    props.team,
    props.picked,
    active
      .filter((entry) => entry.environmentId === props.environmentId)
      .map((entry) => entry.assistant),
    teams.filter((entry) => entry.environmentId === props.environmentId).map((entry) => entry.team),
  );
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-sm font-medium">Projects</legend>
      <p className="text-xs text-muted-foreground">
        Every member can work in these projects, on top of their own.
      </p>
      <ProjectMultiPicker
        environmentId={props.environmentId}
        selected={props.picked}
        onChange={props.onChange}
      />
      {gaining === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {gaining === 1 ? "1 member gains access" : `${gaining} members gain access`}
        </p>
      )}
    </fieldset>
  );
}
