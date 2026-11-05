import {
  type Assistant,
  ASSISTANT_STANDUP_PROMPT_HEAD,
  assistantDescendantIds,
} from "@t3tools/contracts";

type TeamMember = Pick<Assistant, "id" | "name" | "role" | "reportsTo" | "archivedAt">;

export const NO_LEADER_LABEL = "Nobody";

/** Who the assistant can report to: live assistants outside its own branch of the chart. */
export function leaderChoices<A extends TeamMember>(
  assistants: ReadonlyArray<A>,
  selfId: string | null,
): ReadonlyArray<A> {
  const excluded = selfId === null ? new Set<string>() : assistantDescendantIds(assistants, selfId);
  return assistants.filter((entry) => entry.archivedAt === null && !excluded.has(entry.id));
}

export function directReports<A extends TeamMember>(
  assistants: ReadonlyArray<A>,
  leaderId: string,
): ReadonlyArray<A> {
  return assistants.filter((entry) => entry.archivedAt === null && entry.reportsTo === leaderId);
}

/** "CEO · reports to Jarvis", or whichever half exists; null when it has neither. */
export function teamSubtitle(assistant: TeamMember, assistants: ReadonlyArray<TeamMember>) {
  const leader = assistants.find((entry) => entry.id === assistant.reportsTo);
  return (
    [assistant.role, leader ? `reports to ${leader.name}` : ""]
      .filter((part) => part !== "")
      .join(" · ") || null
  );
}

/** Whether the assistant's conversation already has its standup, renamed or paused alike. */
export function hasStandupTask(
  tasks: ReadonlyArray<{ readonly threadId: string | null; readonly prompt: string }>,
  threadId: string | null,
): boolean {
  return (
    threadId !== null &&
    tasks.some(
      (task) => task.threadId === threadId && task.prompt.startsWith(ASSISTANT_STANDUP_PROMPT_HEAD),
    )
  );
}
