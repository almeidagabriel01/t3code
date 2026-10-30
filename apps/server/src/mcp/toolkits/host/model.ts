import type {
  OrchestrationV2ThreadShell,
  ResourceTelemetryHistory,
  ServerProcessResourceHistoryResult,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const NAME_CHARS = 80;
const MESSAGE_CHARS = 200;

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join("");

/** The executable's file name, never its arguments, which can carry paths and secrets. */
export const executableName = (command: string) => {
  const trimmed = command.trim();
  // A Windows path may hold spaces; its executable ends at the first .exe, .cmd or .bat.
  const first =
    /^(.*?\.(?:exe|cmd|bat))(?=\s|$)/i.exec(trimmed)?.[1] ?? trimmed.split(/\s+/)[0] ?? "";
  return clip(first.split(/[\\/]/).at(-1) || "unknown", NAME_CHARS);
};

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

type Shell = Pick<
  OrchestrationV2ThreadShell,
  "archivedAt" | "deletedAt" | "activeRunId" | "pendingRuntimeRequest" | "lineage"
>;

/** Live threads only; a subagent's run counts separately so the top-level numbers match the UI. */
export const countThreads = (shells: ReadonlyArray<Shell>) => {
  const counts = { threads: 0, running: 0, waiting: 0, subagentsRunning: 0 };
  for (const shell of shells) {
    if (shell.deletedAt !== null || shell.archivedAt !== null) continue;
    if (shell.lineage.relationshipToParent === "subagent") {
      if (shell.activeRunId !== null) counts.subagentsRunning += 1;
      continue;
    }
    counts.threads += 1;
    if (shell.pendingRuntimeRequest !== null) counts.waiting += 1;
    else if (shell.activeRunId !== null) counts.running += 1;
  }
  return counts;
};

export const providerStatus = (providers: ReadonlyArray<ServerProvider>) =>
  providers.map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { name: provider.displayName }),
    enabled: provider.enabled,
    installed: provider.installed,
    status: provider.status,
    ...(provider.availability === undefined ? {} : { availability: provider.availability }),
    ...(provider.message === undefined ? {} : { message: clip(provider.message, MESSAGE_CHARS) }),
  }));

const epoch = (at: DateTime.Utc) => DateTime.toEpochMillis(at);
const percent = (value: number) => Math.round(value * 10) / 10;

const bucketOf = (
  bucket: Pick<
    ResourceTelemetryHistory["buckets"][number],
    "startedAt" | "avgCpuPercent" | "maxCpuPercent" | "maxRssBytes" | "maxProcessCount"
  >,
) => ({
  from: epoch(bucket.startedAt),
  avgCpuPercent: percent(bucket.avgCpuPercent),
  maxCpuPercent: percent(bucket.maxCpuPercent),
  maxRssMb: mb(bucket.maxRssBytes),
  processes: bucket.maxProcessCount,
});

const topByCpu = <A extends { readonly avgCpuPercent: number }>(rows: ReadonlyArray<A>) =>
  rows.toSorted((a, b) => b.avgCpuPercent - a.avgCpuPercent);

/** Whole-machine telemetry the way an agent reads it: epoch-millisecond buckets and the busiest processes. */
export const compactResourceHistory = (history: ResourceTelemetryHistory, limit: number) => {
  const rows = topByCpu(history.topProcesses);
  return {
    windowMs: history.windowMs,
    bucketMs: history.bucketMs,
    sampleCount: history.retainedSampleCount,
    buckets: history.buckets.map(bucketOf),
    topProcesses: rows.slice(0, limit).map((process) => ({
      pid: process.identity.pid,
      name: clip(process.name || executableName(process.command), NAME_CHARS),
      category: process.category,
      avgCpuPercent: percent(process.avgCpuPercent),
      maxCpuPercent: percent(process.maxCpuPercent),
      currentRssMb: mb(process.currentRssBytes),
      peakRssMb: mb(process.peakRssBytes),
    })),
    truncated: rows.length > limit,
    ...Option.match(history.health.native.lastError, {
      onNone: () => ({}),
      onSome: (error) => ({ error: clip(error, MESSAGE_CHARS) }),
    }),
  };
};

/** The server's own process tree: the same shape, from the monitor the Processes view reads. */
export const compactProcessHistory = (
  history: ServerProcessResourceHistoryResult,
  limit: number,
) => {
  const rows = topByCpu(history.topProcesses);
  return {
    windowMs: history.windowMs,
    bucketMs: history.bucketMs,
    sampleCount: history.retainedSampleCount,
    totalCpuSeconds: Math.round(history.totalCpuSecondsApprox),
    buckets: history.buckets.map(bucketOf),
    topProcesses: rows.slice(0, limit).map((process) => ({
      pid: process.pid,
      name: executableName(process.command),
      depth: process.depth,
      isServerRoot: process.isServerRoot,
      avgCpuPercent: percent(process.avgCpuPercent),
      maxCpuPercent: percent(process.maxCpuPercent),
      cpuSeconds: Math.round(process.cpuSecondsApprox),
      currentRssMb: mb(process.currentRssBytes),
      peakRssMb: mb(process.maxRssBytes),
    })),
    truncated: rows.length > limit,
    ...Option.match(history.error, {
      onNone: () => ({}),
      onSome: (error) => ({ error: clip(error.message, MESSAGE_CHARS) }),
    }),
  };
};
