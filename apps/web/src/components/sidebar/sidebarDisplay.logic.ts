import {
  PROJECT_HOVER_CARD_PROPERTIES,
  type ProjectHoverCardProperty,
  type SidebarAgentActivityDisplayMode,
} from "@t3tools/contracts";

/** Compact folds several subagents into one summary row; Full lists each one. */
export function resolveSubagentDisplay(input: {
  readonly count: number;
  readonly show: boolean;
  readonly mode: SidebarAgentActivityDisplayMode;
  readonly expanded: boolean;
}): "hidden" | "rows" | "summary" | "summary-and-rows" {
  if (!input.show || input.count === 0) return "hidden";
  if (input.mode === "full" || input.count === 1) return "rows";
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
