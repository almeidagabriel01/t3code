/** The project views a thread opens, the same three tabs web shows in its right panel. */
export const PROJECT_VIEWS = ["activity", "memory", "heavy-work"] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

/** Menu titles and SF Symbol names; each symbol has an Android mapping in AppSymbol. */
export const PROJECT_VIEW_META = {
  activity: { title: "Activity", icon: "bell.badge" },
  memory: { title: "Memory", icon: "brain" },
  "heavy-work": { title: "Heavy work", icon: "hourglass" },
} as const satisfies Record<ProjectView, { readonly title: string; readonly icon: string }>;

export const isProjectView = (value: string): value is ProjectView =>
  (PROJECT_VIEWS as readonly string[]).includes(value);
