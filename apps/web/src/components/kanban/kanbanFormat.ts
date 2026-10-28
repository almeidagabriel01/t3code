const DAY_MS = 86_400_000;

function startOfDay(ms: number) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Tomorrow", "Yesterday", else "Oct 30" (with the year when it is not this one). */
export function formatDueLabel(dueAt: string, now: number): string {
  const due = Date.parse(dueAt);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  const sameYear = new Date(due).getFullYear() === new Date(now).getFullYear();
  return new Date(due).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** An overdue card is due on an earlier day; the due day itself is not overdue. */
export function isDueOverdue(dueAt: string, now: number): boolean {
  return startOfDay(Date.parse(dueAt)) < startOfDay(now);
}
