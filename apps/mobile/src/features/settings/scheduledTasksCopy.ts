export const SCHEDULED_TASKS_COPY = {
  title: "Scheduled tasks",
} as const;

export const SCHEDULED_TASKS_PAGE_LABELS: readonly string[] = [
  ...Object.values(SCHEDULED_TASKS_COPY),
  // What its tasks are and how they fire, shown in each task's editor.
  "automations",
  "cron",
  "recurring",
  "webhook",
];
