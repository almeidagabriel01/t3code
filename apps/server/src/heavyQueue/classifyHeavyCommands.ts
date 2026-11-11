import type { HeavyCommand, HeavyQueueEntry, ResourceTelemetryProcess } from "@t3tools/contracts";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";
import type { ProcessOwner } from "@t3tools/shared/ProcessOwners";
import * as DateTime from "effect/DateTime";

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
const MEMORY_STEP_BELOW_GIB = 4 * 1024 ** 2;
/** The precision surfaces show (MB below a GiB, tenths above), so jitter below it sends no new frame. */
const roundMemory = (bytes: number) => {
  const step = bytes < HEAVY_MEMORY_BYTES ? MEMORY_STEP_BELOW_GIB : TENTH_GIB;
  return Math.round(bytes / step) * step;
};

const queueCommand = (entry: HeavyQueueEntry & { readonly startedAt: string }): HeavyCommand => ({
  source: "queue",
  entryId: entry.id,
  pid: entry.pid,
  startTimeMs: Math.max(0, Date.parse(entry.startedAt) || 0),
  threadId: entry.threadId,
  cwd: entry.cwd,
  label: entry.label,
  name: heavyEntryName(entry),
  startedAt: entry.startedAt,
  stoppable: entry.server !== true,
  ...(entry.cpu === undefined ? {} : { cpu: tenth(entry.cpu) }),
  ...(entry.memory === undefined ? {} : { memory: roundMemory(entry.memory) }),
  ...(entry.peakCpu === undefined ? {} : { peakCpu: tenth(entry.peakCpu) }),
  ...(entry.peakMemory === undefined ? {} : { peakMemory: roundMemory(entry.peakMemory) }),
});

/**
 * Every heavy command running now: started queue entries first, then the direct commands under
 * agent and terminal owners. A queue entry's process tree never counts again as a direct command.
 */
export function classifyHeavyCommands(input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly owners: ReadonlyArray<ProcessOwner>;
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
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
  }

  const direct: HeavyCommand[] = [];
  const trees = new Map<string, ReadonlyArray<number>>();
  const tracked = new Map<string, Tracked>();
  for (const owner of input.owners) {
    if (owner.kind === "device-hub") continue;
    for (const root of commandRoots(owner.pid, children, claimed)) {
      const usage = treeUsage(root, children, claimed);
      const key = commandKey(root.identity.pid, root.identity.startTimeMs);
      const previous = input.previous.get(key);
      const heavy =
        root.runTimeMs >= MIN_RUN_MS &&
        (usage.cpu >= HEAVY_CORES || usage.memoryBytes >= HEAVY_MEMORY_BYTES);
      if (!heavy && (previous === undefined || input.now - previous.lastHeavyAt >= LINGER_MS)) {
        continue;
      }
      const next: Tracked = {
        peakCpu: Math.max(previous?.peakCpu ?? 0, usage.cpu),
        peakMemory: Math.max(previous?.peakMemory ?? 0, usage.memoryBytes),
        lastHeavyAt: heavy ? input.now : previous!.lastHeavyAt,
      };
      tracked.set(key, next);
      trees.set(key, usage.pids);
      const label = root.command || root.name;
      direct.push({
        source: owner.kind,
        pid: root.identity.pid,
        startTimeMs: root.identity.startTimeMs,
        threadId: owner.threadId,
        label,
        name: heavyEntryName({ label, cwd: "" }),
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(root.identity.startTimeMs)),
        stoppable: true,
        cpu: tenth(usage.cpu),
        memory: roundMemory(usage.memoryBytes),
        peakCpu: tenth(next.peakCpu),
        peakMemory: roundMemory(next.peakMemory),
      });
    }
  }
  // Oldest first keeps rows in place while their numbers change.
  direct.sort((a, b) => a.startTimeMs - b.startTimeMs || a.pid - b.pid);
  return { commands: [...running.map(queueCommand), ...direct], trees, tracked };
}
