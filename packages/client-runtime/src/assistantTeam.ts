import type { Assistant } from "@t3tools/contracts";

type TeamMember = Pick<Assistant, "id" | "name" | "role" | "archivedAt">;

export const NO_LEAD_LABEL = "Nobody";

/** The assistant's own role text, or null when it has none. */
export function teamSubtitle(assistant: TeamMember) {
  return assistant.role || null;
}

type TeamLike = {
  readonly memberIds: ReadonlyArray<string>;
  readonly leadId: string | null;
};

/** "3 members · lead Ana", or just the count when the group has no lead. */
export function teamSummary(
  team: TeamLike,
  assistants: ReadonlyArray<Pick<Assistant, "id" | "name">>,
): string {
  const count = `${team.memberIds.length} members`;
  const lead = assistants.find((entry) => entry.id === team.leadId);
  return lead === undefined ? count : `${count} · lead ${lead.name}`;
}

/** Who can join a team: live assistants, plus members that were archived after joining. */
export function teamMemberChoices<A extends Pick<Assistant, "id" | "archivedAt">>(
  assistants: ReadonlyArray<A>,
  team: Pick<TeamLike, "memberIds"> | null,
): ReadonlyArray<A> {
  return assistants.filter(
    (entry) => entry.archivedAt === null || (team?.memberIds.includes(entry.id) ?? false),
  );
}
