/**
 * Runner: where heavy work runs, this Mac or a Linux PC reached over SSH. Every value is a server
 * setting; the ones in `RUNNER_PROJECT_KEYS` also take a per-project override.
 */
import * as Schema from "effect/Schema";

export const RunnerWhere = Schema.Literals(["mac", "linux", "automatic"]);
export type RunnerWhere = typeof RunnerWhere.Type;

/** What a job bound for Linux does when Linux is offline, or dropped it mid-run. */
export const RunnerUnavailablePolicy = Schema.Literals(["ask", "mac", "wait"]);
export type RunnerUnavailablePolicy = typeof RunnerUnavailablePolicy.Type;

/** What an unanswered question does once its deadline passes. */
export const RunnerDeadlineAction = Schema.Literals(["mac", "wait", "cancel"]);
export type RunnerDeadlineAction = typeof RunnerDeadlineAction.Type;

export const RUNNER_LIMITS = {
  runnerOverflow: { min: 0, max: 20, unit: "jobs" },
  runnerAskMinutes: { min: 1, max: 30, unit: "minutes" },
  runnerLinuxSlots: { min: 1, max: 16, unit: "jobs" },
  runnerHeartbeatSeconds: { min: 5, max: 600, unit: "seconds" },
  runnerOfflineAfterFailures: { min: 1, max: 10, unit: "failures" },
  runnerSshTimeoutSeconds: { min: 1, max: 30, unit: "seconds" },
  runnerStopWaitSeconds: { min: 1, max: 60, unit: "seconds" },
} as const;
export type RunnerNumberKey = keyof typeof RUNNER_LIMITS;

export const RUNNER_PATTERNS_MAX = 50;
export const RUNNER_PATTERN_CHARS = 200;

export const RUNNER_DEFAULTS = {
  runnerEnabled: false,
  runnerWhere: "mac" as RunnerWhere,
  runnerOverflow: 3,
  runnerUnavailable: "ask" as RunnerUnavailablePolicy,
  runnerAskMinutes: 5,
  runnerDeadlineAction: "mac" as RunnerDeadlineAction,
  runnerDropped: "ask" as RunnerUnavailablePolicy,
  runnerMacOnly: [
    "xcodebuild",
    "xcrun",
    "simctl",
    "gradle",
    "gradlew",
    "expo run",
    "simulator",
    "emulator",
    "mobile:install",
    "dev:desktop",
  ] as ReadonlyArray<string>,
  // Builds stay off: their artifact would land on the PC while the Mac needs it.
  runnerLinuxCommands: [
    "test",
    "vitest",
    "jest",
    "e2e",
    "playwright",
    "coverage",
    "lint",
    "oxlint",
    "eslint",
    "check",
    "typecheck",
    "tsc",
    "knip",
  ] as ReadonlyArray<string>,
  runnerHost: "remoto",
  runnerLinuxSlots: 2,
  runnerHeartbeatSeconds: 20,
  runnerOfflineAfterFailures: 2,
  runnerSshTimeoutSeconds: 3,
  runnerStopWaitSeconds: 5,
} as const;

/** Settings a project can override; the rest belong to the machine. */
export const RUNNER_PROJECT_KEYS = [
  "runnerEnabled",
  "runnerWhere",
  "runnerOverflow",
  "runnerUnavailable",
  "runnerAskMinutes",
  "runnerDeadlineAction",
  "runnerDropped",
  "runnerMacOnly",
  "runnerLinuxCommands",
] as const;
export const RUNNER_MACHINE_KEYS = [
  "runnerHost",
  "runnerLinuxSlots",
  "runnerHeartbeatSeconds",
  "runnerOfflineAfterFailures",
  "runnerSshTimeoutSeconds",
  "runnerStopWaitSeconds",
] as const;
export type RunnerKey = keyof typeof RUNNER_DEFAULTS;

/** Why `value` is not a valid `key`, for people; null when it is. */
export const runnerNumberError = (key: RunnerNumberKey, value: number): string | null => {
  const { min, max, unit } = RUNNER_LIMITS[key];
  if (!Number.isInteger(value)) return `Use a whole number of ${unit}.`;
  if (value < min || value > max) return `Use ${min} to ${max} ${unit}.`;
  return null;
};

/** An SSH alias or `user@host`; a leading dash would turn it into an ssh option. */
export const runnerHostError = (value: string): string | null => {
  if (value.trim() === "") return "Enter the SSH host or alias.";
  if (value.startsWith("-")) return "A host cannot start with a dash.";
  if (!/^[A-Za-z0-9._@:%[\]-]+$/.test(value)) {
    return "Use the alias from ~/.ssh/config or user@host, with no spaces.";
  }
  return null;
};

/** Normalizes a pattern list as typed: trimmed, without blanks or repeats. */
export const runnerPatterns = (values: ReadonlyArray<string>) => [
  ...new Set(values.map((value) => value.trim()).filter((value) => value !== "")),
];

export const runnerPatternsError = (values: ReadonlyArray<string>): string | null => {
  if (values.length > RUNNER_PATTERNS_MAX) return `Keep it to ${RUNNER_PATTERNS_MAX} patterns.`;
  const long = values.find((value) => value.length > RUNNER_PATTERN_CHARS);
  return long === undefined ? null : `Keep each pattern under ${RUNNER_PATTERN_CHARS} characters.`;
};

const between = (key: RunnerNumberKey) =>
  Schema.Int.check(Schema.makeFilter((value: number) => runnerNumberError(key, value) ?? true));

export const RunnerOverflow = between("runnerOverflow");
export const RunnerAskMinutes = between("runnerAskMinutes");
export const RunnerLinuxSlots = between("runnerLinuxSlots");
export const RunnerHeartbeatSeconds = between("runnerHeartbeatSeconds");
export const RunnerOfflineAfterFailures = between("runnerOfflineAfterFailures");
export const RunnerSshTimeoutSeconds = between("runnerSshTimeoutSeconds");
export const RunnerStopWaitSeconds = between("runnerStopWaitSeconds");
export const RunnerHost = Schema.String.check(
  Schema.makeFilter((value: string) => runnerHostError(value) ?? true),
);
export const RunnerPatterns = Schema.Array(Schema.String).check(
  Schema.makeFilter((values: ReadonlyArray<string>) => runnerPatternsError(values) ?? true),
);

/** One project's effective Runner settings, as the queue file carries them. */
export const RunnerProjectConfig = Schema.Struct({
  runnerEnabled: Schema.Boolean,
  runnerWhere: RunnerWhere,
  runnerOverflow: Schema.Int,
  runnerUnavailable: RunnerUnavailablePolicy,
  runnerAskMinutes: Schema.Int,
  runnerDeadlineAction: RunnerDeadlineAction,
  runnerDropped: RunnerUnavailablePolicy,
  runnerMacOnly: Schema.Array(Schema.String),
  runnerLinuxCommands: Schema.Array(Schema.String),
});
export type RunnerProjectConfig = typeof RunnerProjectConfig.Type;

export const RunnerMachineConfig = Schema.Struct({
  runnerHost: Schema.String,
  runnerLinuxSlots: Schema.Int,
  runnerHeartbeatSeconds: Schema.Int,
  runnerOfflineAfterFailures: Schema.Int,
  runnerSshTimeoutSeconds: Schema.Int,
  runnerStopWaitSeconds: Schema.Int,
});
export type RunnerMachineConfig = typeof RunnerMachineConfig.Type;
