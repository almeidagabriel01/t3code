export const NOTES_COPY = {
  title: "Notes",
  allProjects: "All projects",
} as const;

export const NOTES_PAGE_LABELS: readonly string[] = [
  ...Object.values(NOTES_COPY),
  // What notes are and do; their rows come from the server.
  "markdown",
  "ideas",
  "capture",
  "start work",
];
