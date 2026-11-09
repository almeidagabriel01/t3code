/** A task that posts in a group chat is a routine there; Settings keeps calling it a task. */
export function scheduledTaskWording(group: boolean) {
  const noun = group ? "routine" : "task";
  return {
    noun,
    section: group ? "Routine" : "Task",
    runLimitHint: `The ${noun} turns itself off after this many runs. Empty means no limit.`,
    /** The unit shows only beside a number, so an empty field never reads "No limit runs". */
    runsUnit: (value: string) => (value.trim() === "" ? undefined : "runs"),
    edit: (editing: boolean) => `${editing ? "Edit" : "New"} ${noun}`,
    submit: (editing: boolean) => `${editing ? "Save" : "Create"} ${noun}`,
  };
}
