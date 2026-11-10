import { isAssistantThreadId } from "@t3tools/contracts";

/** A task that posts in a group chat or an assistant's conversation is a routine there. */
export function isRoutineTarget(target: {
  readonly assistantTeamId: string | null;
  readonly threadId: string | null;
}): boolean {
  return Boolean(target.assistantTeamId) || isAssistantThreadId(target.threadId ?? "");
}

/** Assistants call their scheduled tasks routines; Settings keeps calling the rest tasks. */
export function scheduledTaskWording(routine: boolean) {
  const noun = routine ? "routine" : "task";
  return {
    noun,
    section: routine ? "Routine" : "Task",
    runLimitHint: `The ${noun} turns itself off after this many runs. Empty means no limit.`,
    /** The unit shows only beside a number, so an empty field never reads "No limit runs". */
    runsUnit: (value: string) => (value.trim() === "" ? undefined : "runs"),
    edit: (editing: boolean) => `${editing ? "Edit" : "New"} ${noun}`,
    submit: (editing: boolean) => `${editing ? "Save" : "Create"} ${noun}`,
  };
}
