import type { OrchestratorFixtureInput } from "../shared.ts";

export const STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT =
  "Start the dev server in the background with `bun run dev` and keep it running.";

export function stopBackgroundWorkAfterFailedTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "stop_background_work", targetRunIndex: 1 },
    ],
  };
}

/** The idle release ends the agent process, so the command it ran ends with it and Stop has nothing left. */
export function backgroundWorkEndsWithReleasedSessionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "failed" },
      { type: "capture_shell_snapshot", key: "before-release" },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "await_no_background_work" },
    ],
  };
}
