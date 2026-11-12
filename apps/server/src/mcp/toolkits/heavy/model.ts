import type { HeavyCommand, HeavyQueueEntry, HeavyQueueState } from "@t3tools/contracts";
import { heavyEntryName } from "@t3tools/shared/heavyEntryName";

const LOAD_PER_CORE_HIGH = 1.5;
const MEMORY_FREE_LOW = 0.1;
const BUSY_AGENTS = 2;

const round = (value: number) => Math.round(value * 100) / 100;

/** Overloaded only when the machine is strained and several agents are adding to it. */
export const heavyStatus = (input: {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly threadId: string | undefined;
  readonly busyCores: number;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly workingAgents: number;
  readonly maxRunning: number;
  /** False: the queue is off, so nothing waits and there is nothing to ask the user about. */
  readonly enabled: boolean;
  /** The queue sees room to start more work now. */
  readonly room: boolean;
  readonly reasons: Readonly<Record<string, string>>;
  /** The reading the queue last decided on; null when none is fresh. */
  readonly machine: HeavyQueueState["machine"];
  /** The Linux runner, when on; null otherwise. */
  readonly linux: HeavyQueueState["linux"];
  /** Where each waiter would run if a slot opened now. */
  readonly routes: HeavyQueueState["routes"];
  readonly command: string;
  /** Every heavy command running now, queued or run directly, with its tree's usage. */
  readonly commands: ReadonlyArray<HeavyCommand>;
}) => {
  const loadPerCore = input.busyCores / Math.max(1, input.cpuCount);
  const availableMemoryPercent =
    input.totalMemoryBytes > 0 ? (input.availableMemoryBytes / input.totalMemoryBytes) * 100 : 100;
  const high =
    (loadPerCore >= LOAD_PER_CORE_HIGH || availableMemoryPercent / 100 < MEMORY_FREE_LOW) &&
    input.workingAgents >= BUSY_AGENTS;
  const active = input.entries.filter((entry) => entry.startedAt !== null);
  const running = active[0] ?? null;
  const waiting = input.entries
    .filter((entry) => entry.startedAt === null)
    .map((entry, index) => ({
      ...entry,
      name: heavyEntryName(entry),
      position: index + 1,
      ...(input.reasons[entry.id] === undefined ? {} : { reason: input.reasons[entry.id] }),
      ...(input.routes[entry.id] === undefined ? {} : { runsOn: input.routes[entry.id] }),
    }));
  return {
    // Ask only when work would wait: pressure is high, or others queue and no slot is free soon.
    askUser:
      input.enabled &&
      (high ||
        (input.entries.length > active.length &&
          (active.length >= input.maxRunning || !input.room))),
    pressure: {
      high,
      loadPerCore: round(loadPerCore),
      availableMemoryPercent: round(availableMemoryPercent),
      workingAgents: input.workingAgents,
    },
    running: running === null ? null : { ...running, name: heavyEntryName(running) },
    machine: input.machine,
    linux: input.linux,
    runningCount: active.length,
    maxRunning: input.maxRunning,
    waiting,
    yours: input.entries
      .filter((entry) => entry.threadId !== null && entry.threadId === input.threadId)
      .map((entry) => ({
        id: entry.id,
        position: waiting.find((waiter) => waiter.id === entry.id)?.position ?? 0,
      })),
    command: input.command,
    commands: input.commands.map((command) => ({
      name: command.name,
      source: command.source,
      threadId: command.threadId,
      pid: command.pid,
      startedAt: command.startedAt,
      cpuCores: command.cpu ?? null,
      memoryBytes: command.memory ?? null,
      peakCpuCores: command.peakCpu ?? null,
      peakMemoryBytes: command.peakMemory ?? null,
    })),
  };
};
