/** The Archive page's fixed labels; Settings search reads these same strings. */
export const ARCHIVE_COPY = {
  title: "Archived threads",
  environment: "Environment",
  allEnvironments: "All environments",
  sortByArchivedDate: "Sort by archived date",
  newestFirst: "Newest first",
  oldestFirst: "Oldest first",
} as const;

export const ARCHIVE_PAGE_LABELS: readonly string[] = [
  ...Object.values(ARCHIVE_COPY),
  // The actions on each archived thread row.
  "restore",
  "unarchive",
];
