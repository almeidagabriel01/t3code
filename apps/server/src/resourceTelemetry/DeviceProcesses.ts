import type {
  ResourceMonitorExternalProcess,
  ResourceMonitorProcessTableEntry,
} from "@t3tools/contracts";

// Linux truncates names to 15 bytes, so `qemu-system-aar` must match too.
const DEVICE_ROOT_NAME = /^(?:launchd_sim|Simulator|emulator|qemu-system-[^\s\\/]+)(?:\.exe)?$/;

/** The top process of a booted iOS simulator, the Simulator app, or an Android emulator. */
export const isDeviceRootName = (name: string): boolean => DEVICE_ROOT_NAME.test(name);

/** Device roots in a whole-machine process table, ordered by pid. */
export const deviceRoots = (
  table: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): ReadonlyArray<ResourceMonitorExternalProcess> =>
  table
    .filter((entry) => isDeviceRootName(entry.name))
    .map((entry) => ({ pid: entry.pid }))
    .toSorted((left, right) => left.pid - right.pid);
