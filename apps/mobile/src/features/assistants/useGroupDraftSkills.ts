import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import {
  assistantGroupAddress,
  type Assistant,
  type EnvironmentId,
  type ModelSelection,
  type ServerProviderSkill,
} from "@t3tools/contracts";

import { useEnvironmentServerConfig, useProject, useQuietThreadShell } from "../../state/entities";

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];

/**
 * The skills of the provider a draft runs on: the message's own model, else the model of the member
 * it names first or replies to, else the lead's, read in that member's checkout. A member with no
 * thread offers none.
 */
export function useGroupDraftSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly members: ReadonlyArray<Assistant>;
  readonly lead: Assistant | null;
  /** The name a reply goes to, if any. */
  readonly replyTo: string | null;
  /** The message's own model pick. */
  readonly model: ModelSelection | null | undefined;
}): ReadonlyArray<ServerProviderSkill> {
  const recipient =
    assistantGroupAddress(input.text, input.members)?.[0] ??
    input.members.find((member) => member.name === input.replyTo) ??
    input.lead;
  const thread = useQuietThreadShell(
    recipient?.threadId == null ? null : scopeThreadRef(input.environmentId, recipient.threadId),
  );
  const project = useProject(
    recipient === null ? null : scopeProjectRef(input.environmentId, recipient.projectId),
  );
  const config = useEnvironmentServerConfig(input.environmentId);
  if (thread === null) return NO_SKILLS;
  const instanceId = input.model?.instanceId ?? thread.modelSelection.instanceId;
  const provider = config?.providers.find((candidate) => candidate.instanceId === instanceId);
  return provider === undefined
    ? NO_SKILLS
    : resolveProviderSkillsForCwd(provider, thread.worktreePath ?? project?.workspaceRoot);
}
