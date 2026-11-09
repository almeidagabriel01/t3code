/** A task that posts in a group chat is a routine there; Settings keeps calling it a task. */
export function scheduledTaskWording(group: boolean) {
  const noun = group ? "routine" : "task";
  return {
    noun,
    edit: (editing: boolean) => `${editing ? "Edit" : "New"} ${noun}`,
    submit: (editing: boolean) => `${editing ? "Save" : "Create"} ${noun}`,
  };
}
