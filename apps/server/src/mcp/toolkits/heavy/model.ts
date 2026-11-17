import type {
  HeavyCommand,
  HeavyQueueEntry,
  HeavyQueueState,
  HeavyRunner,
} from "@t3tools/contracts";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";

const LOAD_PER_CORE_HIGH = 1.5;
const MEMORY_FREE_LOW = 0.1;
const BUSY_AGENTS = 2;

const round = (value: number) => Math.round(value * 100) / 100;

/** Where the queue's own plan would send a command started now (`HeavyQueue.probe`). */
export interface Destination {
  /** "direct": the hook leaves it alone, as a commit with no hook to run. */
  readonly runsOn: HeavyRunner | "direct";
  readonly reason: string | null;
  readonly startsNow: boolean;
  /** Linux is offline, over its limits or out of slots. */
  readonly linuxFull: boolean;
}

/** Each machine answers for itself: Linux jobs never count against this Mac, nor its pressure against them. */
export const heavyStatus = (input: {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly threadId: string | undefined;
  readonly busyCores: number;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly workingAgents: number;
  readonly maxRunning: number;
  /** False: the queue is off, so nothing waits on this Mac. */
  readonly enabled: boolean;
  /** The queue sees room to start more work on this Mac now. */
  readonly room: boolean;
  readonly reasons: Readonly<Record<string, string>>;
  /** This Mac's reading the queue last decided on; null when none is fresh. */
  readonly machine: HeavyQueueState["machine"];
  /** The Linux runner, when on; null otherwise. */
  readonly linux: HeavyQueueState["linux"];
  /** Where each waiter would run if a slot opened now. */
  readonly routes: HeavyQueueState["routes"];
  readonly command: string;
  /** Every heavy command running now, queued or run directly, with its tree's usage on this Mac. */
  readonly commands: ReadonlyArray<HeavyCommand>;
  /** The command the agent asked about; null when it sent none. */
  readonly destination: Destination | null;
}) => {
  const loadPerCore = input.busyCores / Math.max(1, input.cpuCount);
  const availableMemoryPercent =
    input.totalMemoryBytes > 0 ? (input.availableMemoryBytes / input.totalMemoryBytes) * 100 : 100;
  // Overloaded only when this Mac is strained and several agents are adding to it.
  const high =
    (loadPerCore >= LOAD_PER_CORE_HIGH || availableMemoryPercent / 100 < MEMORY_FREE_LOW) &&
    input.workingAgents >= BUSY_AGENTS;
  // Only with the Runner on, so the output stays as it was for everyone else.
  const tag = (runsOn: HeavyRunner) => (input.linux === null ? {} : { runsOn });
  const runnerOf = (entry: HeavyQueueEntry): HeavyRunner =>
    (entry.startedAt === null ? input.routes[entry.id] : entry.runner) ?? "mac";
  const active = input.entries.filter((entry) => entry.startedAt !== null);
  const macRunning = active.filter((entry) => runnerOf(entry) === "mac").length;
  const positions: Record<HeavyRunner, number> = { mac: 0, linux: 0 };
  const waiting = input.entries
    .filter((entry) => entry.startedAt === null)
    .map((entry) => {
      const runsOn = runnerOf(entry);
      positions[runsOn] += 1;
      return {
        ...entry,
        name: heavyEntryName(entry),
        // Its place in the line for its own machine.
        position: positions[runsOn],
        ...(input.reasons[entry.id] === undefined ? {} : { reason: input.reasons[entry.id] }),
        ...tag(runsOn),
      };
    });
  const macWaiting = waiting.some((entry) => runnerOf(entry) === "mac");
  // Ask only when work would wait here: pressure is high, or others queue and no slot is free soon.
  const macAsk =
    input.enabled && (high || (macWaiting && (macRunning >= input.maxRunning || !input.room)));
  const { destination } = input;
  const runnerOfEntry = new Map(input.entries.map((entry) => [entry.id, runnerOf(entry)]));
  return {
    askUser:
      destination?.runsOn === "direct"
        ? false
        : destination?.runsOn === "linux"
          ? !destination.startsNow && destination.linuxFull
          : macAsk,
    ...(destination === null
      ? {}
      : {
          runsOn: destination.runsOn,
          ...(destination.reason === null ? {} : { reason: destination.reason }),
        }),
    mac: {
      pressure: {
        high,
        loadPerCore: round(loadPerCore),
        availableMemoryPercent: round(availableMemoryPercent),
        workingAgents: input.workingAgents,
      },
      reading: input.machine,
      running: macRunning,
      maxRunning: input.maxRunning,
    },
    ...(input.linux === null ? {} : { linux: input.linux }),
    running: active.map((entry) => ({
      ...entry,
      name: heavyEntryName(entry),
      ...tag(runnerOf(entry)),
    })),
    waiting,
    yours: input.entries
      .filter((entry) => entry.threadId !== null && entry.threadId === input.threadId)
      .map((entry) => ({
        id: entry.id,
        position: waiting.find((waiter) => waiter.id === entry.id)?.position ?? 0,
        ...tag(runnerOf(entry)),
      })),
    command: input.command,
    commands: input.commands.map((command) => {
      const runsOn =
        (command.entryId === undefined ? undefined : runnerOfEntry.get(command.entryId)) ?? "mac";
      // A Linux job's tree here is only `t3 heavy` waiting on ssh; its usage is on Linux.
      const here = runsOn === "mac";
      return {
        name: command.name,
        source: command.source,
        threadId: command.threadId,
        pid: command.pid,
        startedAt: command.startedAt,
        ...tag(runsOn),
        cpuCores: here ? (command.cpu ?? null) : null,
        memoryBytes: here ? (command.memory ?? null) : null,
        peakCpuCores: here ? (command.peakCpu ?? null) : null,
        peakMemoryBytes: here ? (command.peakMemory ?? null) : null,
      };
    }),
  };
};
