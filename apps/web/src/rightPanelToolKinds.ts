/** Singleton panels scoped to the thread's project: one tab each, opened from the launcher and quick buttons. */
export const RIGHT_PANEL_TOOL_KINDS = ["notes", "activity", "memory", "heavy-work"] as const;
export type RightPanelToolKind = (typeof RIGHT_PANEL_TOOL_KINDS)[number];

export const isRightPanelToolKind = (kind: string): kind is RightPanelToolKind =>
  (RIGHT_PANEL_TOOL_KINDS as readonly string[]).includes(kind);

/** One value per tool kind, so adding a kind never touches the call sites. */
export const mapRightPanelTools = <T>(value: (kind: RightPanelToolKind) => T) =>
  Object.fromEntries(RIGHT_PANEL_TOOL_KINDS.map((kind) => [kind, value(kind)])) as Record<
    RightPanelToolKind,
    T
  >;
