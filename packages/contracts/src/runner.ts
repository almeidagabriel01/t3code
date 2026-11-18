/**
 * Runner: where heavy work runs, this Mac or a Linux PC reached over SSH. Every value is a server
 * setting; the ones in `RUNNER_PROJECT_KEYS` also take a per-project override.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** `automatic` is Hybrid; `macFirst` fills this Mac up to `runnerMacFirstAfter` jobs first. */
export const RunnerWhere = Schema.Literals(["mac", "linux", "automatic", "macFirst"]);
export type RunnerWhere = typeof RunnerWhere.Type;

/** What a job bound for Linux does when Linux is offline. */
export const RunnerUnavailablePolicy = Schema.Literals(["ask", "mac", "wait"]);
export type RunnerUnavailablePolicy = typeof RunnerUnavailablePolicy.Type;

/** What a job does when Linux couldn't run it; `agent` hands the failure back without a rerun. */
export const RunnerFailedPolicy = Schema.Literals(["agent", "ask", "mac", "wait"]);
export type RunnerFailedPolicy = typeof RunnerFailedPolicy.Type;

/** What an unanswered question does once its deadline passes. */
export const RunnerDeadlineAction = Schema.Literals(["mac", "wait", "cancel"]);
export type RunnerDeadlineAction = typeof RunnerDeadlineAction.Type;

/** In Linux mode, what a job does while Linux is full: wait, take this Mac's room, or the shorter queue. */
export const RunnerLinuxFullPolicy = Schema.Literals(["wait", "mac", "balance"]);
export type RunnerLinuxFullPolicy = typeof RunnerLinuxFullPolicy.Type;

export const RUNNER_LIMITS = {
  runnerAskMinutes: { min: 1, max: 30, unit: "minutes" },
  runnerMacFirstAfter: { min: 1, max: 32, unit: "jobs" },
  runnerLinuxSlots: { min: 1, max: 16, unit: "jobs" },
  runnerHeartbeatSeconds: { min: 5, max: 600, unit: "seconds" },
  runnerOfflineAfterFailures: { min: 2, max: 10, unit: "failures" },
  runnerSshTimeoutSeconds: { min: 1, max: 30, unit: "seconds" },
  runnerStopWaitSeconds: { min: 1, max: 60, unit: "seconds" },
  runnerLinuxMemoryFloorPercent: { min: 5, max: 80, unit: "percent" },
  runnerLinuxCpuCeilingPercent: { min: 20, max: 100, unit: "percent" },
} as const;
export type RunnerNumberKey = keyof typeof RUNNER_LIMITS;

export const RUNNER_PATTERNS_MAX = 50;
export const RUNNER_PATTERN_CHARS = 200;

export const RUNNER_DEFAULTS = {
  runnerEnabled: false,
  runnerWhere: "mac" as RunnerWhere,
  runnerUnavailable: "ask" as RunnerUnavailablePolicy,
  runnerLinuxFull: "wait" as RunnerLinuxFullPolicy,
  runnerAskMinutes: 5,
  runnerDeadlineAction: "mac" as RunnerDeadlineAction,
  runnerDropped: "agent" as RunnerFailedPolicy,
  runnerMacFirstAfter: 4,
  runnerLinuxEverything: false,
  runnerBringBack: true,
  runnerRouteMemoryDays: 7,
  /** Environment faults that teach a route: this program in this package then skips Linux. */
  runnerRouteLearnAfter: 2,
  /** File or folder names (`*` globs) never copied back from Linux. */
  runnerBringBackExclude: [
    "node_modules",
    ".git",
    ".turbo",
    "*.tsbuildinfo",
    // Native build output: a Linux build's binaries would replace this Mac's.
    "target",
    ".build",
    "DerivedData",
    "CMakeFiles",
    "*.o",
  ] as ReadonlyArray<string>,
  /** A run whose results come to more than this many MB copies nothing back. */
  runnerBringBackMaxMB: 200,
  /** Programs only this Mac has: a heavy call that runs one stays here. */
  runnerMacTools: [
    "xcodebuild",
    "xcrun",
    "simctl",
    "emulator",
    "adb",
    "instruments",
    "pod",
    "pbcopy",
    "security",
    "defaults",
    "open",
    "osascript",
    "screencapture",
    "agent-device",
    // It measures this Mac.
    "hyperfine",
    // It signs and ships with this Mac's keychain and Xcode.
    "fastlane",
  ] as ReadonlyArray<string>,
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
    "mocha",
    "pytest",
    "e2e",
    "playwright",
    "coverage",
    "lint",
    "oxlint",
    "eslint",
    "check",
    "clippy",
    "typecheck",
    "tsc",
    "tsgo",
    "effect-tsgo",
    "knip",
  ] as ReadonlyArray<string>,
  runnerHost: "remoto",
  runnerLinuxSlots: 2,
  runnerHeartbeatSeconds: 20,
  runnerOfflineAfterFailures: 2,
  runnerSshTimeoutSeconds: 3,
  runnerStopWaitSeconds: 5,
  // A Linux job starts only while the PC keeps this much memory free and stays under this CPU use.
  runnerLinuxMemoryFloorPercent: 20,
  runnerLinuxCpuCeilingPercent: 70,
  /** A job Linux stopped this often for memory beside others waits to run there alone. */
  runnerLinuxEvictionsBeforeAlone: 2,
} as const;

/** Settings a project can override; the rest belong to the machine. */
export const RUNNER_PROJECT_KEYS = [
  "runnerEnabled",
  "runnerWhere",
  "runnerUnavailable",
  "runnerLinuxFull",
  "runnerAskMinutes",
  "runnerDeadlineAction",
  "runnerDropped",
  "runnerMacOnly",
  "runnerLinuxCommands",
  "runnerMacFirstAfter",
  "runnerLinuxEverything",
  "runnerBringBack",
  "runnerRouteMemoryDays",
  "runnerRouteLearnAfter",
  "runnerBringBackExclude",
  "runnerBringBackMaxMB",
  "runnerMacTools",
] as const;
export const RUNNER_MACHINE_KEYS = [
  "runnerHost",
  "runnerLinuxSlots",
  "runnerHeartbeatSeconds",
  "runnerOfflineAfterFailures",
  "runnerSshTimeoutSeconds",
  "runnerStopWaitSeconds",
  "runnerLinuxMemoryFloorPercent",
  "runnerLinuxCpuCeilingPercent",
  "runnerLinuxEvictionsBeforeAlone",
  "heavySlowAgentJobs",
] as const;
/** Agents' running jobs drop to background CPU priority while this Mac stays over its CPU ceiling. */
export const HEAVY_SLOW_AGENT_JOBS_DEFAULT = true;
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

export const RunnerAskMinutes = between("runnerAskMinutes");
export const RunnerMacFirstAfter = between("runnerMacFirstAfter");
export const RunnerLinuxSlots = between("runnerLinuxSlots");
export const RunnerHeartbeatSeconds = between("runnerHeartbeatSeconds");
/** One failure never takes Linux offline, so a 1 saved before the minimum rose reads as 2. */
export const RunnerOfflineAfterFailures = Schema.Int.pipe(
  Schema.decodeTo(
    between("runnerOfflineAfterFailures"),
    SchemaTransformation.transform({
      decode: (value: number) =>
        value === 1 ? RUNNER_LIMITS.runnerOfflineAfterFailures.min : value,
      encode: (value: number) => value,
    }),
  ),
);
export const RunnerSshTimeoutSeconds = between("runnerSshTimeoutSeconds");
export const RunnerStopWaitSeconds = between("runnerStopWaitSeconds");
export const RunnerLinuxMemoryFloorPercent = between("runnerLinuxMemoryFloorPercent");
export const RunnerLinuxCpuCeilingPercent = between("runnerLinuxCpuCeilingPercent");
export const RunnerLinuxEvictionsBeforeAlone = Schema.Int.check(
  Schema.makeFilter((value: number) => (value >= 1 && value <= 10) || "Use 1 to 10 stops."),
);
/** Days a call with a learned route keeps going to this Mac. */
export const RunnerRouteMemoryDays = Schema.Int.check(
  Schema.makeFilter((value: number) => (value >= 1 && value <= 90) || "Use 1 to 90 days."),
);
export const RunnerRouteLearnAfter = Schema.Int.check(
  Schema.makeFilter((value: number) => (value >= 1 && value <= 10) || "Use 1 to 10 failures."),
);
export const RunnerBringBackMaxMB = Schema.Int.check(
  Schema.makeFilter((value: number) => (value >= 1 && value <= 10_240) || "Use 1 to 10240 MB."),
);
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
  runnerUnavailable: RunnerUnavailablePolicy,
  runnerLinuxFull: RunnerLinuxFullPolicy.pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerLinuxFull)),
  ),
  runnerAskMinutes: Schema.Int,
  runnerDeadlineAction: RunnerDeadlineAction,
  runnerDropped: RunnerFailedPolicy,
  runnerMacOnly: Schema.Array(Schema.String),
  runnerMacFirstAfter: Schema.Int,
  runnerBringBack: Schema.Boolean,
  // Older publishers' blocks lack it.
  runnerRouteMemoryDays: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerRouteMemoryDays)),
  ),
  runnerRouteLearnAfter: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerRouteLearnAfter)),
  ),
  runnerBringBackExclude: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerBringBackExclude)),
  ),
  runnerBringBackMaxMB: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerBringBackMaxMB)),
  ),
  runnerMacTools: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerMacTools)),
  ),
});
export type RunnerProjectConfig = typeof RunnerProjectConfig.Type;

export const RunnerMachineConfig = Schema.Struct({
  runnerHost: Schema.String,
  runnerLinuxSlots: Schema.Int,
  runnerHeartbeatSeconds: Schema.Int,
  runnerOfflineAfterFailures: Schema.Int,
  runnerSshTimeoutSeconds: Schema.Int,
  runnerStopWaitSeconds: Schema.Int,
  runnerLinuxMemoryFloorPercent: Schema.Int,
  runnerLinuxCpuCeilingPercent: Schema.Int,
  runnerLinuxEvictionsBeforeAlone: Schema.Int.pipe(
    Schema.withDecodingDefault(Effect.succeed(RUNNER_DEFAULTS.runnerLinuxEvictionsBeforeAlone)),
  ),
  heavySlowAgentJobs: Schema.Boolean,
});
export type RunnerMachineConfig = typeof RunnerMachineConfig.Type;
