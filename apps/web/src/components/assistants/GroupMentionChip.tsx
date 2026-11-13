import {
  assistantGroupMentions,
  assistantGroupProjectSlug,
  foldAssistantGroupText,
  type Assistant,
  type EnvironmentId,
} from "@t3tools/contracts";
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
  if (props.kind === "project") {
    const slug = foldAssistantGroupText(props.value);
    const project = props.projects.find(
      (candidate) => assistantGroupProjectSlug(candidate.name) === slug,
    );
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
  const mention = assistantGroupMentions(`@${props.value}`, props.members)[0];
  const member = mention?.member ?? undefined;
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
      <ContextChipLabel>{member?.name ?? (mention ? "everyone" : props.value)}</ContextChipLabel>
    </ContextChip>
  );
}
