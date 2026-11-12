// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The one memory reading the heavy queue trusts, shared by the server sampler and the `t3 heavy`
 * CLI. Plain Node: the CLI fast path loads it before the Effect runtime.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

export interface MemoryReading {
  /** RAM a new job can take without paging: compressed pages and wired memory count as used. */
  readonly availableMemoryBytes: number;
  readonly totalMemoryBytes: number;
  /** macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. Null elsewhere. */
  readonly pressureLevel: number | null;
  /** Bytes swapped in since boot; the rate between two readings is what signals thrashing. */
  readonly swapInBytes: number | null;
}

const count = (text: string, label: string) => {
  const value = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m").exec(text)?.[1];
  return value === undefined ? null : Number(value);
};

/**
 * Activity Monitor's arithmetic: used = app (anonymous minus purgeable) + wired + compressor.
 * Free plus inactive reads ~30% free while the compressor and swap are full.
 */
export const parseDarwinMemory = (
  vmStat: string,
  pressure: string,
  totalMemoryBytes: number,
): MemoryReading | null => {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1] ?? Number.NaN);
  const anonymous = count(vmStat, "Anonymous pages");
  const purgeable = count(vmStat, "Pages purgeable");
  const wired = count(vmStat, "Pages wired down");
  const compressor = count(vmStat, "Pages occupied by compressor");
  if (
    !(pageSize > 0) ||
    anonymous === null ||
    purgeable === null ||
    wired === null ||
    compressor === null
  ) {
    return null;
  }
  const used = (anonymous - purgeable + wired + compressor) * pageSize;
  const swapIns = count(vmStat, "Swapins");
  const level = Number.parseInt(pressure.trim(), 10);
  return {
    availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, totalMemoryBytes - used)),
    totalMemoryBytes,
    pressureLevel: Number.isFinite(level) ? level : null,
    swapInBytes: swapIns === null ? null : swapIns * pageSize,
  };
};

export const parseLinuxMemory = (
  meminfo: string,
  vmstat: string,
  totalMemoryBytes: number,
): MemoryReading | null => {
  const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  if (available === undefined) return null;
  const pages = /^pswpin\s+(\d+)$/m.exec(vmstat)?.[1];
  return {
    availableMemoryBytes: Math.min(totalMemoryBytes, Number(available) * 1024),
    totalMemoryBytes,
    pressureLevel: null,
    // ponytail: assumes 4 KiB pages, true on x86_64 and default arm64 kernels.
    swapInBytes: pages === undefined ? null : Number(pages) * 4096,
  };
};

/** Bytes per second swapped in between two readings; null without a usable pair. */
export const swapInRate = (
  previous: { readonly at: number; readonly swapInBytes: number | null } | null,
  current: { readonly at: number; readonly swapInBytes: number | null },
): number | null => {
  if (previous === null || previous.swapInBytes === null || current.swapInBytes === null) {
    return null;
  }
  const seconds = (current.at - previous.at) / 1000;
  return seconds > 0 ? Math.max(0, current.swapInBytes - previous.swapInBytes) / seconds : null;
};

const run = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(command, args, {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Synchronous, for the CLI waiter; the server runs the same commands through its spawner. */
// oxlint-disable-next-line t3code/no-global-process-runtime -- The CLI fast path runs before any Effect runtime.
export const readMemorySync = (platform: NodeJS.Platform = NodeOS.platform()): MemoryReading => {
  const totalMemoryBytes = NodeOS.totalmem();
  try {
    if (platform === "darwin") {
      const reading = parseDarwinMemory(
        run("/usr/bin/vm_stat", []),
        run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
        totalMemoryBytes,
      );
      if (reading !== null) return reading;
    } else if (platform === "linux") {
      const reading = parseLinuxMemory(
        NodeFS.readFileSync("/proc/meminfo", "utf8"),
        NodeFS.readFileSync("/proc/vmstat", "utf8"),
        totalMemoryBytes,
      );
      if (reading !== null) return reading;
    }
  } catch {
    // Fall through to what Node reports.
  }
  // Windows' freemem includes standby memory, so it is a fair "available" there.
  return {
    availableMemoryBytes: NodeOS.freemem(),
    totalMemoryBytes,
    pressureLevel: null,
    swapInBytes: null,
  };
};
