import {
  HEAVY_QUEUE_DEFAULTS,
  type HeavyCommand,
  type HeavyQueueEntry,
  type ResourceTelemetryProcess,
} from "@t3tools/contracts";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";
import type { ProcessOwner } from "@t3tools/shared/ProcessOwners";
import * as DateTime from "effect/DateTime";

import { costOf } from "./costClass.ts";
import { readLine } from "./heavyHook.ts";

/** Summed over the tree: half a core, or 1 GiB resident, as the Resource Manager flags a process. */
const HEAVY_CORES = 0.5;
export const HEAVY_MEMORY_BYTES = 1024 ** 3;
/** Younger roots are quick tools (rg, git) caught mid-spike, not work worth a row. */
const MIN_RUN_MS = 3_000;
/** Hysteresis: a tree stays listed this long after its last heavy sample, so a dip does not hide it. */
export const LINGER_MS = 10_000;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh"]);

const base = (path: string) => path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

/** Agents wrap each command in `zsh -c …`; the command is what the shell runs. */
const isShell = (process: Pick<ResourceTelemetryProcess, "name">) =>
  SHELLS.has(base(process.name).replace(/^-/, "").toLowerCase());

export type ChildrenByParent = ReadonlyMap<number, ReadonlyArray<ResourceTelemetryProcess>>;

export const childrenByParent = (
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ChildrenByParent => {
  const children = new Map<number, ResourceTelemetryProcess[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid);
    if (siblings === undefined) children.set(process.ppid, [process]);
    else siblings.push(process);
  }
  return children;
};

export interface TreeUsage {
  /** Cores: process CPU percents count 100 per core. */
  readonly cpu: number;
  readonly memoryBytes: number;
  readonly pids: ReadonlyArray<number>;
}

/** `root` and everything beneath it, leaving out `skip` pids and their subtrees. */
export const treeUsage = (
  root: ResourceTelemetryProcess,
  children: ChildrenByParent,
  skip: ReadonlySet<number> = new Set(),
): TreeUsage => {
  let cpu = 0;
  let memoryBytes = 0;
  const pids: number[] = [];
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const pid = next.identity.pid;
    if (seen.has(pid) || skip.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    cpu += next.cpuPercent / 100;
    memoryBytes += next.residentBytes;
    stack.push(...(children.get(pid) ?? []));
  }
  return { cpu, memoryBytes, pids };
};

/** The non-shell processes under `ownerPid`, looking through shell wrappers and stopping at `stop`. */
const commandRoots = (
  ownerPid: number,
  children: ChildrenByParent,
  stop: ReadonlySet<number>,
): ReadonlyArray<ResourceTelemetryProcess> => {
  const roots: ResourceTelemetryProcess[] = [];
  const seen = new Set<number>();
  const stack = [...(children.get(ownerPid) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const pid = next.identity.pid;
    if (seen.has(pid) || stop.has(pid)) continue;
    seen.add(pid);
    if (isShell(next)) stack.push(...(children.get(pid) ?? []));
    else roots.push(next);
  }
  return roots;
};

/** `node /x/.bin/vitest run` as `/x/.bin/vitest run`: a process line names its interpreter first. */
const NODE_SCRIPT = /^(?:\S*\/)?node(?:\s+-\S+)*\s+(?=[^-\s])/;

/** Parsing ~900 process lines costs ~40 ms a sample; the lines barely change between samples. */
const heavyLines = new Map<string, boolean>();
const HEAVY_LINES_MAX = 4096;

/**
 * Heavy by the hook's own rules, read from a process's command line. Only its program counts:
 * argv loses its quotes, so `ssh host 'cd w && npm test'` reads as two commands.
 */
const isHeavyProcess = (process: ResourceTelemetryProcess) => {
  if (isShell(process)) return false;
  const line = process.command || process.name;
  let heavy = heavyLines.get(line);
  if (heavy === undefined) {
    const first = (text: string) => readLine(text).parts[0]?.heavy === true;
    heavy = first(line) || first(line.replace(NODE_SCRIPT, ""));
    if (heavyLines.size >= HEAVY_LINES_MAX) heavyLines.clear();
    heavyLines.set(line, heavy);
  }
  return heavy;
};

export const DETACHED_REASON = "Started outside an agent, so the queue can't route it";

export interface Tracked {
  readonly peakCpu: number;
  readonly peakMemory: number;
  readonly lastHeavyAt: number;
}

export interface Classification {
  readonly commands: ReadonlyArray<HeavyCommand>;
  /** Pids each direct command's Stop may signal, by `pid:startTimeMs`. */
  readonly trees: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Carry into the next call: the hysteresis and peak state. */
  readonly tracked: ReadonlyMap<string, Tracked>;
}

export const commandKey = (pid: number, startTimeMs: number) => `${pid}:${startTimeMs}`;
const tenth = (value: number) => Math.round(value * 10) / 10;
const TENTH_GIB = HEAVY_MEMORY_BYTES / 10;
const MIB = 1024 ** 2;
/** The precision surfaces show (MB below a GiB, tenths above); a running command never reads 0 MB. */
const roundMemory = (bytes: number) => {
  const step = bytes < HEAVY_MEMORY_BYTES ? MIB : TENTH_GIB;
  return bytes > 0 ? Math.max(MIB, Math.round(bytes / step) * step) : 0;
};

/**
 * A Linux job's local tree is only the `remoto` wrapper, so its usage says nothing; files written
 * by a version that sampled it still carry those numbers.
 */
export const withoutUsage = <E extends HeavyQueueEntry>({
  cpu: _cpu,
  memory: _memory,
  peakCpu: _peakCpu,
  peakMemory: _peakMemory,
  ...entry
}: E) => entry;

const queueCommand = (entry: HeavyQueueEntry & { readonly startedAt: string }): HeavyCommand => {
  const usage: Partial<Pick<HeavyQueueEntry, "cpu" | "memory" | "peakCpu" | "peakMemory">> =
    entry.runner === "linux" ? {} : entry;
  return {
    source: "queue",
    ...(entry.runner === "linux" ? { runner: "linux" as const } : {}),
    entryId: entry.id,
    pid: entry.pid,
    startTimeMs: Math.max(0, Date.parse(entry.startedAt) || 0),
    threadId: entry.threadId,
    cwd: entry.cwd,
    label: entry.label,
    name: heavyEntryName(entry),
    startedAt: entry.startedAt,
    stoppable: entry.server !== true,
    ...(usage.cpu === undefined ? {} : { cpu: tenth(usage.cpu) }),
    ...(usage.memory === undefined ? {} : { memory: roundMemory(usage.memory) }),
    ...(usage.peakCpu === undefined ? {} : { peakCpu: tenth(usage.peakCpu) }),
    ...(usage.peakMemory === undefined ? {} : { peakMemory: roundMemory(usage.peakMemory) }),
  };
};

/**
 * Every heavy command running now: started queue entries first, then the direct commands under
 * agent and terminal owners, then heavy commands nothing in T3 started (a detached script's
 * playwright). A queue entry's process tree never counts again as a direct command.
 */
export function classifyHeavyCommands(input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly owners: ReadonlyArray<ProcessOwner>;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  /** This T3 server: its tree and its launchers are T3's own, never detached work. */
  readonly serverPid: number;
  /** The sample's time, in epoch milliseconds. */
  readonly now: number;
  readonly previous: ReadonlyMap<string, Tracked>;
}): Classification {
  const children = childrenByParent(input.processes);
  const byPid = new Map(input.processes.map((process) => [process.identity.pid, process]));
  const running = input.entries.filter(
    (entry): entry is HeavyQueueEntry & { readonly startedAt: string } => entry.startedAt !== null,
  );
  // Owners' own trees belong to them; a server-held entry's pid is the server, whose tree is everything.
  const claimed = new Set<number>(input.owners.map((owner) => owner.pid));
  for (const entry of running) {
    const root = entry.server === true ? undefined : byPid.get(entry.pid);
    if (root !== undefined) for (const pid of treeUsage(root, children).pids) claimed.add(pid);
    // Daemons the sampler found working for it count in its row, not as detached work.
    for (const pid of entry.daemons ?? []) claimed.add(pid);
  }

  const direct: HeavyCommand[] = [];
  const trees = new Map<string, ReadonlyArray<number>>();
  const tracked = new Map<string, Tracked>();
  /** Lists the root while it is heavy, or was within the linger, carrying its peaks. */
  const list = (
    root: ResourceTelemetryProcess,
    usage: TreeUsage,
    row: Pick<HeavyCommand, "source" | "threadId" | "stoppable" | "reason">,
  ) => {
    const key = commandKey(root.identity.pid, root.identity.startTimeMs);
    const previous = input.previous.get(key);
    const heavy =
      root.runTimeMs >= MIN_RUN_MS &&
      (usage.cpu >= HEAVY_CORES || usage.memoryBytes >= HEAVY_MEMORY_BYTES);
    if (!heavy && (previous === undefined || input.now - previous.lastHeavyAt >= LINGER_MS)) {
      return;
    }
    const next: Tracked = {
      peakCpu: Math.max(previous?.peakCpu ?? 0, usage.cpu),
      peakMemory: Math.max(previous?.peakMemory ?? 0, usage.memoryBytes),
      lastHeavyAt: heavy ? input.now : previous!.lastHeavyAt,
    };
    tracked.set(key, next);
    const label = root.command || root.name;
    direct.push({
      ...row,
      pid: root.identity.pid,
      startTimeMs: root.identity.startTimeMs,
      label,
      name: heavyEntryName({ label, cwd: "" }),
      ...(costOf({ label }, null, HEAVY_QUEUE_DEFAULTS.quickSeconds).class === "service"
        ? { keepsRunning: true }
        : {}),
      startedAt: DateTime.formatIso(DateTime.makeUnsafe(root.identity.startTimeMs)),
      cpu: tenth(usage.cpu),
      memory: roundMemory(usage.memoryBytes),
      peakCpu: tenth(next.peakCpu),
      peakMemory: roundMemory(next.peakMemory),
    });
  };

  for (const owner of input.owners) {
    if (owner.kind === "device-hub") continue;
    for (const root of commandRoots(owner.pid, children, claimed)) {
      const usage = treeUsage(root, children, claimed);
      // Every command stays stoppable: a row on screen may be a sample behind its usage.
      trees.set(commandKey(root.identity.pid, root.identity.startTimeMs), usage.pids);
      list(root, usage, { source: owner.kind, threadId: owner.threadId, stoppable: true });
    }
  }

  // Detached work is what T3 neither runs nor launched: outside the server and its launchers,
  // every owner and every queue job.
  const ours = new Set(claimed);
  for (const pid of [input.serverPid, ...input.owners.map((owner) => owner.pid)]) {
    const root = byPid.get(pid);
    if (root !== undefined) for (const tree of treeUsage(root, children).pids) ours.add(tree);
  }
  for (let at = byPid.get(input.serverPid)?.ppid; at !== undefined && at > 1;) {
    ours.add(at);
    at = byPid.get(at)?.ppid;
  }
  // Parents start first, so the topmost heavy process claims its tree before a heavy child is seen.
  const byAge = input.processes.toSorted(
    (a, b) => a.identity.startTimeMs - b.identity.startTimeMs || a.identity.pid - b.identity.pid,
  );
  for (const root of byAge) {
    if (ours.has(root.identity.pid)) continue;
    const parent = byPid.get(root.ppid);
    // A command a shell or a detached script ran, not an app's helper (an editor's tsgo --lsp).
    if (parent !== undefined && parent.identity.pid > 1 && !isShell(parent)) continue;
    if (!isHeavyProcess(root)) continue;
    const usage = treeUsage(root, children, ours);
    for (const pid of usage.pids) ours.add(pid);
    // No T3 thread or terminal started it, so Stop gets no `trees` key to signal.
    list(root, usage, {
      source: "detached",
      threadId: null,
      stoppable: false,
      reason: DETACHED_REASON,
    });
  }
  // Oldest first keeps rows in place while their numbers change.
  direct.sort((a, b) => a.startTimeMs - b.startTimeMs || a.pid - b.pid);
  return { commands: [...running.map(queueCommand), ...direct], trees, tracked };
}
