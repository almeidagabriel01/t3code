import {
  HEAVY_LIMIT_COPY,
  HEAVY_NOTICES_COPY,
  RUNNER_SETTING_COPY,
} from "@t3tools/client-runtime/state/runnerModel";

/** The heavy queue section's fixed labels; Settings search reads these same strings. */
export const HEAVY_QUEUE_LABEL = {
  queue: "Heavy work queue",
  pause: "Pause queue",
  claudeHook: "Claude Code hook",
  idleSimulators: "Power off idle simulators",
  thisMac: "This Mac",
  jobSizing: "Job sizing",
  allowMore: "Allow one more",
  allowFewer: "Allow one fewer",
  slowAgentJobs: "Slow down agent jobs when the Mac is busy",
} as const;

/** Every label the Maintenance page draws for the heavy queue, its notices and the Runner. */
export const MAINTENANCE_PAGE_LABELS: readonly string[] = [
  ...Object.values(HEAVY_QUEUE_LABEL),
  ...Object.values(HEAVY_LIMIT_COPY).map(({ title }) => title),
  HEAVY_NOTICES_COPY.title,
  ...Object.values(RUNNER_SETTING_COPY).map(({ title }) => title),
];
