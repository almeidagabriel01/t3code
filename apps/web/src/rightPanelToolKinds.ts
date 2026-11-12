/** Singleton panels scoped to the thread's project: one tab each, opened from the launcher and quick buttons. */
export const RIGHT_PANEL_TOOL_KINDS = ["notes", "kanban", "scheduled-tasks"] as const;
export type RightPanelToolKind = (typeof RIGHT_PANEL_TOOL_KINDS)[number];

export const isRightPanelToolKind = (kind: string): kind is RightPanelToolKind =>
  (RIGHT_PANEL_TOOL_KINDS as readonly string[]).includes(kind);
