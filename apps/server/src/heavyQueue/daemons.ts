/**
 * Build daemons run outside a job's tree (launchd adopts them; a warm Gradle daemon predates it).
 * One counts for the job that talks to it over a local socket, or whose folder holds its own when
 * it started during the job. Only Gradle and Kotlin daemons: a database a test uses is shared.
 */
// @effect-diagnostics nodeBuiltinImport:off
import type { HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { childrenByParent, treeUsage } from "./classifyHeavyCommands.ts";

export interface DaemonClues {
  /** Local processes joined by a TCP connection, each pair once per connection. */
  readonly links: ReadonlyArray<readonly [number, number]>;
  /** Working folder by pid, for processes launchd adopted. */
  readonly cwds: ReadonlyMap<number, string>;
  /** Short command name by pid (lsof's `c` field), for every process with a TCP connection. */
  readonly names: ReadonlyMap<number, string>;
}

export const NO_CLUES: DaemonClues = { links: [], cwds: new Map(), names: new Map() };

const BUILD_DAEMON = /\b(?:GradleDaemon|KotlinCompileDaemon)\b/;

/** A Gradle or Kotlin compile daemon, by its command line; their workers come with their trees. */
export const isBuildDaemon = (process: Pick<ResourceTelemetryProcess, "command">) =>
  BUILD_DAEMON.test(process.command);

/** Whether `ps -axo command=` output lists a Gradle or Kotlin daemon. */
export const hasBuildDaemon = (commands: string) => BUILD_DAEMON.test(commands);

/**
 * Whether a build daemon is up anywhere on this machine: one that outlived its job is no queue
 * job's process, so the monitor does not see it, yet its memory is already in the reading.
 */
export const anyBuildDaemon = Effect.fn("HeavyQueueDaemons.anyBuildDaemon")(
  function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return hasBuildDaemon(
      yield* spawner
        .string(
          ChildProcess.make("/bin/ps", ["-axo", "command="], { stdin: "ignore", stderr: "ignore" }),
        )
        .pipe(Effect.timeout("2 seconds")),
    );
  },
  Effect.orElseSucceed(() => false),
);

/** `lsof -F pn` records: each `p<pid>` line, then the `n<name>` lines of its files. */
const records = (text: string) => {
  const out: Array<readonly [number, string]> = [];
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) out.push([pid, line.slice(1)]);
  }
  return out;
};

/** A connection between two local processes shows once from each end, `a->b` and `b->a`. */
export const parseLinks = (text: string): DaemonClues["links"] => {
  const ends = new Map<string, number>();
  for (const [pid, name] of records(text)) if (name.includes("->")) ends.set(name, pid);
  const links: Array<readonly [number, number]> = [];
  for (const [name, pid] of ends) {
    const [from, to] = name.split("->");
    const other = ends.get(`${to}->${from}`);
    if (other !== undefined && other !== pid && from! < to!) links.push([pid, other]);
  }
  return links;
};

export const parseCwds = (text: string): Map<number, string> => new Map(records(text));

/** Each pid's `c<command>` line in `lsof -F pcn` output. */
export const parseNames = (text: string): Map<number, string> => {
  const names = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid > 0) names.set(pid, line.slice(1));
  }
  return names;
};

/** Processes launchd adopted, outside every pid in `claimed`. */
export const adoptedRoots = (
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  claimed: ReadonlySet<number> = new Set(),
) =>
  processes.filter(
    (process) =>
      process.ppid <= 1 && process.identity.pid > 1 && !claimed.has(process.identity.pid),
  );

const runsHere = (entry: HeavyQueueEntry) =>
  entry.startedAt !== null && entry.runner !== "linux" && entry.server !== true;

const inside = (folder: string, root: string) =>
  folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * Each running job's daemons, as every pid of their trees, by entry id. A daemon two jobs reach
 * goes to the one that started first. `exclude` keeps T3's own launchers out (the server's
 * ancestors), which a test may reach over a socket.
 */
export const attributeDaemons = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  clues: DaemonClues,
  exclude: ReadonlySet<number> = new Set(),
): Record<string, ReadonlyArray<number>> => {
  const children = childrenByParent(processes);
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const jobs = entries
    .filter(runsHere)
    .map((entry) => ({ entry, root: byPid.get(entry.pid), startMs: Date.parse(entry.startedAt!) }))
    .filter((job) => job.root !== undefined)
    .toSorted((a, b) => a.startMs - b.startMs);
  const owner = new Map<number, string>();
  for (const { entry, root } of jobs) {
    for (const pid of treeUsage(root!, children).pids)
      if (!owner.has(pid)) owner.set(pid, entry.id);
  }
  const roots = new Map(
    adoptedRoots(processes, new Set([...owner.keys(), ...exclude]))
      .filter(isBuildDaemon)
      .map((process) => [process.identity.pid, process]),
  );
  const linked = new Map<number, number[]>();
  for (const [a, b] of clues.links) {
    linked.set(a, [...(linked.get(a) ?? []), b]);
    linked.set(b, [...(linked.get(b) ?? []), a]);
  }
  const daemons: Record<string, number[]> = {};
  const claim = (id: string, root: ResourceTelemetryProcess) => {
    roots.delete(root.identity.pid);
    const pids = treeUsage(root, children, new Set(owner.keys())).pids;
    for (const pid of pids) owner.set(pid, id);
    (daemons[id] ??= []).push(...pids);
    return pids;
  };
  /** Follows sockets from `from` to every adopted root they reach, through the ones claimed. */
  const spread = (id: string, from: ReadonlyArray<number>) => {
    const queue = [...from];
    for (let at = 0; at < queue.length; at += 1) {
      for (const pid of linked.get(queue[at]!) ?? []) {
        const root = roots.get(pid);
        if (root !== undefined) queue.push(...claim(id, root));
      }
    }
  };
  for (const { entry } of jobs) {
    spread(
      entry.id,
      [...owner].filter(([, id]) => id === entry.id).map(([pid]) => pid),
    );
  }
  // Deepest folder first, so a job in a subfolder wins over one at the repository root.
  const byFolder = jobs.toSorted((a, b) => b.entry.cwd.length - a.entry.cwd.length);
  // Roots claimed while iterating are deleted, so the loop never visits them.
  for (const root of roots.values()) {
    const cwd = clues.cwds.get(root.identity.pid);
    if (cwd === undefined) continue;
    const job = byFolder.find(
      ({ entry, startMs }) => root.identity.startTimeMs >= startMs && inside(cwd, entry.cwd),
    );
    if (job !== undefined) spread(job.entry.id, claim(job.entry.id, root));
  }
  return daemons;
};

/**
 * Java processes the snapshot lacks that a running job reaches over local sockets, directly or
 * through each other: the monitor samples only the trees it is given, so a warm Gradle daemon
 * (and the Kotlin daemon behind it) shows up only once registered. The next sample attributes them.
 */
export const unseenJavaPeers = (
  entries: ReadonlyArray<HeavyQueueEntry>,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  clues: DaemonClues,
): ReadonlyArray<number> => {
  const children = childrenByParent(processes);
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const linked = new Map<number, number[]>();
  for (const [a, b] of clues.links) {
    linked.set(a, [...(linked.get(a) ?? []), b]);
    linked.set(b, [...(linked.get(b) ?? []), a]);
  }
  const queue = entries.filter(runsHere).flatMap((entry) => {
    const root = byPid.get(entry.pid);
    return [
      ...(root === undefined ? [] : treeUsage(root, children).pids),
      ...(entry.daemons ?? []),
    ];
  });
  const visited = new Set(queue);
  const found: number[] = [];
  for (let at = 0; at < queue.length; at += 1) {
    for (const pid of linked.get(queue[at]!) ?? []) {
      if (visited.has(pid) || byPid.has(pid) || clues.names.get(pid) !== "java") continue;
      visited.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
};

/** Working folders don't change for a daemon's life, so each is read once per process. */
const cwdCache = new Map<string, string | null>();

/**
 * The sockets and folders `attributeDaemons` needs, in one `lsof` for sockets and one for the
 * folders of adopted roots it has not seen; empty off macOS or when `lsof` fails.
 */
export const readClues = Effect.fn("HeavyQueueDaemons.readClues")(
  function* (candidates: ReadonlyArray<ResourceTelemetryProcess>) {
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin") return NO_CLUES;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = (args: ReadonlyArray<string>) =>
      spawner
        .string(ChildProcess.make("/usr/sbin/lsof", args, { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          // One sample's interval: a stuck lsof never delays the next sample.
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => ""),
        );
    const keyOf = (process: ResourceTelemetryProcess) =>
      `${process.identity.pid}:${process.identity.startTimeMs}`;
    const unseen = candidates.filter((process) => !cwdCache.has(keyOf(process)));
    const [sockets, folders] = yield* Effect.all(
      [
        output(["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"]),
        unseen.length === 0
          ? Effect.succeed("")
          : output([
              "-a",
              "-d",
              "cwd",
              "-p",
              unseen.map((process) => process.identity.pid).join(","),
              "-Fpn",
            ]),
      ],
      { concurrency: 2 },
    );
    // An empty answer is a failed call, retried next time; a pid it could not read stays unknown.
    if (folders !== "") {
      const read = parseCwds(folders);
      for (const process of unseen) {
        cwdCache.set(keyOf(process), read.get(process.identity.pid) ?? null);
      }
    }
    const live = new Set(candidates.map(keyOf));
    for (const key of cwdCache.keys()) if (!live.has(key)) cwdCache.delete(key);
    const cwds = new Map<number, string>();
    for (const process of candidates) {
      const cwd = cwdCache.get(keyOf(process));
      if (cwd !== null && cwd !== undefined) cwds.set(process.identity.pid, cwd);
    }
    return { links: parseLinks(sockets), cwds, names: parseNames(sockets) } satisfies DaemonClues;
  },
  Effect.orElseSucceed(() => NO_CLUES),
);
