import { assistantGroupMentionTarget } from "@t3tools/client-runtime/assistantGroupChat";
import type { Assistant, EnvironmentId } from "@t3tools/contracts";
import { AtSignIcon, FolderIcon } from "lucide-react";

import { useProjects } from "../../state/entities";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ProjectFavicon } from "../ProjectFavicon";
import { AssistantAvatar } from "./assistantPresentation";

export interface GroupMentionProject {
  readonly id: string;
  readonly name: string;
}

/**
 * A member (`@handle`, a name, or `everyone`) or a group project (`#slug`) as a chip in the
 * composer's chip family: the member's face or the project's icon, then the name.
 */
export function GroupMentionChip(props: {
  readonly kind: "member" | "project";
  /** The handle or name after `@`, or the slug after `#`. */
  readonly value: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly projects: ReadonlyArray<GroupMentionProject>;
  readonly environmentId: EnvironmentId;
}) {
  const environmentProjects = useProjects();
  const target = assistantGroupMentionTarget(
    props.kind,
    props.value,
    props.members,
    props.projects,
  );
  if (props.kind === "project") {
    const project = target?.kind === "project" ? target.project : undefined;
    const known = environmentProjects.find(
      (candidate) =>
        candidate.environmentId === props.environmentId && candidate.id === project?.id,
    );
    return (
      <ContextChip
        kind="mention"
        data-testid="group-mention-chip"
        data-mention-kind="project"
        contentEditable={false}
        spellCheck={false}
      >
        {known ? (
          <ProjectFavicon project={known} className="size-[1em] self-center" />
        ) : (
          <FolderIcon aria-hidden />
        )}
        <ContextChipLabel>{project?.name ?? props.value}</ContextChipLabel>
      </ContextChip>
    );
  }
  const member = target?.kind === "member" ? (target.member ?? undefined) : undefined;
  return (
    <ContextChip
      kind="mention"
      data-testid="group-mention-chip"
      data-mention-kind="member"
      contentEditable={false}
      spellCheck={false}
    >
      {member ? (
        <AssistantAvatar
          assistant={member}
          environmentId={props.environmentId}
          className="size-[1.15em] self-center"
        />
      ) : (
        <AtSignIcon aria-hidden />
      )}
      <ContextChipLabel>{member?.name ?? (target ? "everyone" : props.value)}</ContextChipLabel>
    </ContextChip>
  );
}
