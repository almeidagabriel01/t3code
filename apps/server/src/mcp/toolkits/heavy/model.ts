import type { HeavyQueueEntry } from "@t3tools/contracts";

const LOAD_PER_CORE_HIGH = 1.5;
const MEMORY_FREE_LOW = 0.1;
const BUSY_AGENTS = 2;

const round = (value: number) => Math.round(value * 100) / 100;

/** Overloaded only when the machine is strained and several agents are adding to it. */
export const heavyStatus = (input: {
  readonly entries: ReadonlyArray<HeavyQueueEntry>;
  readonly threadId: string | undefined;
  readonly load1: number;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  readonly workingAgents: number;
  readonly command: string;
}) => {
  const loadPerCore = input.load1 / Math.max(1, input.cpuCount);
  const availableMemoryPercent =
    input.totalMemoryBytes > 0 ? (input.availableMemoryBytes / input.totalMemoryBytes) * 100 : 100;
  const high =
    (loadPerCore >= LOAD_PER_CORE_HIGH || availableMemoryPercent / 100 < MEMORY_FREE_LOW) &&
    input.workingAgents >= BUSY_AGENTS;
  const running = input.entries.find((entry) => entry.startedAt !== null) ?? null;
  const waiting = input.entries
    .filter((entry) => entry.startedAt === null)
    .map((entry, index) => ({ ...entry, position: index + 1 }));
  return {
    askUser: high || input.entries.length > 0,
    pressure: {
      high,
      loadPerCore: round(loadPerCore),
      availableMemoryPercent: round(availableMemoryPercent),
      workingAgents: input.workingAgents,
    },
    running,
    waiting,
    yours: input.entries
      .filter((entry) => entry.threadId !== null && entry.threadId === input.threadId)
      .map((entry) => ({
        id: entry.id,
        position: waiting.find((waiter) => waiter.id === entry.id)?.position ?? 0,
      })),
    command: input.command,
  };
};
