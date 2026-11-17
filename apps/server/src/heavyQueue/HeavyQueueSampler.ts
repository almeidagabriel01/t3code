/**
 * Publishes the machine reading and each running job's peak usage into the queue file, so every
 * waiter decides admission on the same numbers. Reuses the host and process-tree samplers.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HostResources } from "../resourceTelemetry/HostResources.ts";
import { ResourceTelemetry } from "../resourceTelemetry/ResourceTelemetry.ts";
import { childrenByParent, treeUsage } from "./classifyHeavyCommands.ts";
import {
  adoptedRoots,
  anyBuildDaemon,
  attributeDaemons,
  isBuildDaemon,
  readClues,
  unseenJavaPeers,
} from "./daemons.ts";
import { treePids } from "./HeavyQueue.ts";
import * as QueueFile from "./queueFile.ts";
import { applySlowdown, isNoop, slowdownStep } from "./slowdown.ts";

const SAMPLE_INTERVAL = "2 seconds";

/** `footprint -f bytes` output to bytes by pid; a pid it could not read is simply absent. */
export const parseFootprint = (text: string) =>
  new Map(
    [...text.matchAll(/\[(\d+)\]:[^\n]*?Footprint:\s+(\d+)\s+B/g)].map(
      ([, pid, bytes]) => [Number(pid), Number(bytes)] as const,
    ),
  );

/**
 * A job is its entry's process and everything beneath it, plus the daemons working for it
 * (`daemons`, by entry), in cores and bytes. `footprints`, by entry, replaces resident bytes:
 * under compression RSS shows a fraction of what a job holds.
 */
export const peaksOf = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  footprints: Readonly<Record<string, number>> = {},
  daemons: Readonly<Record<string, ReadonlyArray<number>>> = {},
  treeFootprints: Readonly<Record<string, number>> = {},
) => {
  const children = childrenByParent(processes);
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const peaks: Record<
    string,
    // Null when the monitor did not see the job's root: unknown, never idle.
    {
      cpu: number | null;
      memoryBytes: number;
      treeMemoryBytes?: number;
      daemons?: ReadonlyArray<number>;
    }
  > = {};
  for (const entry of entries) {
    // A Linux job's local tree is only `remoto`'s wrapper.
    if (entry.startedAt === null || entry.runner === "linux") continue;
    const root = byPid.get(entry.pid);
    const footprint = footprints[entry.id];
    if (root === undefined) {
      if (footprint !== undefined) peaks[entry.id] = { cpu: null, memoryBytes: footprint };
      continue;
    }
    const tree = treeUsage(root, children);
    const helpers = (daemons[entry.id] ?? []).flatMap((pid) => byPid.get(pid) ?? []);
    peaks[entry.id] = {
      cpu: helpers.reduce((sum, process) => sum + process.cpuPercent / 100, tree.cpu),
      memoryBytes:
        footprint ??
        helpers.reduce((sum, process) => sum + process.residentBytes, tree.memoryBytes),
      ...(helpers.length === 0
        ? {}
        : {
            daemons: helpers.map((process) => process.identity.pid),
            ...(footprint === undefined
              ? { treeMemoryBytes: tree.memoryBytes }
              : treeFootprints[entry.id] === undefined
                ? {}
                : { treeMemoryBytes: treeFootprints[entry.id]! }),
          }),
    };
  }
  return peaks;
};

/**
 * What booted simulators and emulators hold beyond their resident pages: compressed or swapped
 * out now, it comes back the moment they are used, so the queue keeps it free.
 */
export const deviceReserve = (
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  footprints: ReadonlyMap<number, number>,
) =>
  processes
    .filter((process) => process.category === "external-device")
    .reduce(
      (sum, process) =>
        sum + Math.max(0, (footprints.get(process.identity.pid) ?? 0) - process.residentBytes),
      0,
    );

const NO_FOOTPRINTS: {
  readonly jobs: Readonly<Record<string, number>>;
  /** Each job's own tree alone, without the daemons `jobs` adds. */
  readonly trees: Readonly<Record<string, number>>;
  readonly byPid: ReadonlyMap<number, number>;
} = { jobs: {}, trees: {}, byPid: new Map() };

/**
 * macOS physical footprint of each running `t3 heavy` job's tree and its `daemons` (`jobs`, by
 * entry) and of each pid in `devicePids` (`byPid`); empty elsewhere.
 */
export const readFootprints = Effect.fn("HeavyQueueSampler.readFootprints")(
  function* (
    entries: ReadonlyArray<HeavyQueueEntry>,
    devicePids: ReadonlyArray<number> = [],
    daemons: Readonly<Record<string, ReadonlyArray<number>>> = {},
  ) {
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = (program: string, args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" }))
        .pipe(Effect.timeout("2 seconds"));
    // A server-held slot's pid is T3 itself, whose tree is everything.
    const jobs = entries.filter(
      (entry) => entry.startedAt !== null && entry.server !== true && entry.runner !== "linux",
    );
    if (platform !== "darwin" || (jobs.length === 0 && devicePids.length === 0)) {
      return NO_FOOTPRINTS;
    }
    const ps = jobs.length === 0 ? "" : yield* output("/bin/ps", ["-axo", "pid=,ppid="]);
    const own = jobs.map((entry) => [entry.id, treePids(ps, entry.pid)] as const);
    const trees = own.map(([id, pids]) => [id, [...pids, ...(daemons[id] ?? [])]] as const);
    const byPid = parseFootprint(
      yield* output("/usr/bin/footprint", [
        "-f",
        "bytes",
        "--noCategories",
        ...new Set([...trees.flatMap(([, pids]) => pids), ...devicePids].map(String)),
      ]),
    );
    const sumOf = (pids: ReadonlyArray<number>) =>
      pids.reduce((sum, pid) => sum + (byPid.get(pid) ?? 0), 0);
    const total = (list: ReadonlyArray<readonly [string, ReadonlyArray<number>]>) =>
      Object.fromEntries(list.map(([id, pids]) => [id, sumOf(pids)])) as Record<string, number>;
    return { jobs: total(trees), trees: total(own), byPid };
  },
  Effect.orElseSucceed(() => NO_FOOTPRINTS),
);

/** This server and the launchers above it: a test may reach them over a socket, yet they are T3's. */
const serverChain = (processes: ReadonlyArray<ResourceTelemetryProcess>) => {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const chain = new Set<number>();
  for (let at: number | undefined = process.pid; at !== undefined && at > 1 && !chain.has(at);) {
    chain.add(at);
    at = byPid.get(at)?.ppid;
  }
  return chain;
};

/**
 * Each running Mac job's daemons. Folders are read only for adopted processes that started after
 * the oldest running job, the only ones the folder rule can pick.
 */
const daemonsOf = Effect.fnUntraced(function* (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
) {
  const starts = entries
    .filter(
      (entry) => entry.startedAt !== null && entry.runner !== "linux" && entry.server !== true,
    )
    .map((entry) => Date.parse(entry.startedAt!));
  if (starts.length === 0) return { daemons: {}, unseen: [] };
  const exclude = serverChain(processes);
  const oldest = Math.min(...starts);
  const clues = yield* readClues(
    adoptedRoots(processes, exclude).filter((process) => process.identity.startTimeMs >= oldest),
  );
  return {
    daemons: attributeDaemons(entries, processes, clues, exclude),
    unseen: unseenJavaPeers(entries, processes, clues),
  };
});

/**
 * What the monitor must sample beside T3's tree: each running Mac job's root, its daemons, and the
 * Java processes it talks to that no sample has seen yet.
 */
const jobRootsOf = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  daemons: Readonly<Record<string, ReadonlyArray<number>>>,
  unseen: ReadonlyArray<number>,
) => {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const pids = new Set([
    ...entries
      .filter(
        (entry) => entry.startedAt !== null && entry.runner !== "linux" && entry.server !== true,
      )
      .map((entry) => entry.pid),
    ...Object.values(daemons).flat(),
    ...unseen,
  ]);
  return [...pids].map((pid) => {
    const startTimeMs = byPid.get(pid)?.identity.startTimeMs;
    return startTimeMs === undefined ? { pid } : { pid, startTimeMs };
  });
};

/** Every pid a running job holds, its daemons included. */
const jobPidsOf = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  daemons: Readonly<Record<string, ReadonlyArray<number>>>,
) => {
  const children = childrenByParent(processes);
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  return new Set([
    ...entries.flatMap((entry) => {
      const root = entry.startedAt === null ? undefined : byPid.get(entry.pid);
      return root === undefined ? [] : treeUsage(root, children).pids;
    }),
    ...Object.values(daemons).flat(),
  ]);
};

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const host = yield* HostResources;
      const telemetry = yield* ResourceTelemetry;
      const platform = yield* HostProcess.Platform;
      // A whole-table `ps` while jobs wait; daemons live for minutes, so one look per 30 s is enough.
      const daemonsAnywhere = yield* Effect.cachedWithTTL(anyBuildDaemon(), "30 seconds");
      const tick = Effect.gen(function* () {
        const { entries, slowedDaemons } = QueueFile.readDoc(dir);
        // Daemons left lowered after their job ended are restored even with the queue empty.
        if (entries.length === 0 && slowedDaemons.length === 0) {
          yield* telemetry.setJobRoots([]);
          return;
        }
        const reading = yield* host.read;
        const running = entries.some((entry) => entry.startedAt !== null);
        // Devices live for minutes, so the last snapshot finds them while nothing runs.
        const snapshot = running
          ? yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest))
          : yield* telemetry.latest;
        const processes = snapshot?.processes ?? [];
        const found = running ? yield* daemonsOf(entries, processes) : { daemons: {}, unseen: [] };
        const { daemons } = found;
        yield* telemetry.setJobRoots(jobRootsOf(entries, processes, daemons, found.unseen));
        // Registered jobs sample outside T3's tree like devices do, but hold no device reserve.
        const jobPids = jobPidsOf(entries, processes, daemons);
        const devices = processes.filter(
          (process) => process.category === "external-device" && !jobPids.has(process.identity.pid),
        );
        const footprints = yield* readFootprints(
          entries,
          devices.map((process) => process.identity.pid),
          daemons,
        );
        const at = yield* Clock.currentTimeMillis;
        const written = QueueFile.recordSample(
          dir,
          {
            at,
            // The host reading's short-window utilisation tracks load now; the load average lags a minute.
            busyCores:
              reading.cpuUtilization === null
                ? (NodeOS.loadavg()[0] ?? 0)
                : reading.cpuUtilization * reading.cpuCount,
            cpuCount: reading.cpuCount,
            availableMemoryBytes: Math.max(
              0,
              reading.availableMemoryBytes - deviceReserve(devices, footprints.byPid),
            ),
            totalMemoryBytes: reading.totalMemoryBytes,
            pressureLevel: reading.memoryPressureLevel ?? null,
            swapInBytesPerSecond: reading.swapInBytesPerSecond ?? null,
            buildDaemonsAlive:
              processes.some(isBuildDaemon) ||
              (entries.some((entry) => entry.startedAt === null) && (yield* daemonsAnywhere)),
          },
          running ? peaksOf(entries, processes, footprints.jobs, daemons, footprints.trees) : {},
        );
        // Only the primary writer slows jobs down, so two servers never fight over one job's QoS.
        if (platform !== "darwin" || written === null || !written.primary) return;
        const { doc } = written;
        const step = slowdownStep(doc, processes, at);
        if (isNoop(step, doc.slowedDaemons)) return;
        yield* applySlowdown(step);
        QueueFile.recordSlowdown(dir, step);
      }).pipe(Effect.ignore);
      yield* tick.pipe(
        Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
