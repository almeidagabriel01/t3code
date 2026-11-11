export type AssistantTaskStatus = "running" | "waiting" | "done" | "failed";

/** `runtimeStatus` is the thread's run status, "idle" while parked on background work, null when it never ran. */
export function assistantTaskStatusOf(input: {
  readonly needsUser: boolean;
  readonly runtimeStatus: string | null;
}): AssistantTaskStatus {
  if (input.needsUser) return "waiting";
  switch (input.runtimeStatus) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "idle":
      return "running";
    case "failed":
      return "failed";
    default:
      return "done";
  }
}
