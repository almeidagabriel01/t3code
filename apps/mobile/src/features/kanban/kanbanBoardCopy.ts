export const KANBAN_BOARD_COPY = {
  title: "Board",
  allProjects: "All projects",
} as const;

export const KANBAN_PAGE_LABELS: readonly string[] = [
  ...Object.values(KANBAN_BOARD_COPY),
  // Web names this page Kanban.
  "kanban",
];
