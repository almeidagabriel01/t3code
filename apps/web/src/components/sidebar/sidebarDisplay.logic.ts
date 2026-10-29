import {
  PROJECT_HOVER_CARD_PROPERTIES,
  type ProjectHoverCardProperty,
  type SidebarAgentActivityDisplayMode,
} from "@t3tools/contracts";

const COMPACT_SUBAGENT_ROWS = 3;

/** Compact lists up to three subagents and folds more into one summary row; Full lists each one. */
export function resolveSubagentDisplay(input: {
  readonly count: number;
  readonly show: boolean;
  readonly mode: SidebarAgentActivityDisplayMode;
  readonly expanded: boolean;
}): "hidden" | "rows" | "summary" | "summary-and-rows" {
  if (!input.show || input.count === 0) return "hidden";
  if (input.mode === "full" || input.count <= COMPACT_SUBAGENT_ROWS) return "rows";
  return input.expanded ? "summary-and-rows" : "summary";
}

export function toggleHoverCardProperty(
  current: readonly ProjectHoverCardProperty[],
  property: ProjectHoverCardProperty,
  enabled: boolean,
): ProjectHoverCardProperty[] {
  return PROJECT_HOVER_CARD_PROPERTIES.filter((candidate) =>
    candidate === property ? enabled : current.includes(candidate),
  );
}

/** Live port counts by sidebar project key, summing the projects a group merges. */
export function countLivePortsByProject(
  ports: ReadonlyArray<{ readonly projectId: string | null }>,
  groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjects: ReadonlyArray<{ readonly id: string }>;
  }>,
): ReadonlyMap<string, number> {
  const byProject = new Map<string, number>();
  for (const port of ports) {
    if (port.projectId !== null)
      byProject.set(port.projectId, (byProject.get(port.projectId) ?? 0) + 1);
  }
  const counts = new Map<string, number>();
  for (const group of groups) {
    const count = group.memberProjects.reduce(
      (sum, member) => sum + (byProject.get(member.id) ?? 0),
      0,
    );
    if (count > 0) counts.set(group.projectKey, count);
  }
  return counts;
}
