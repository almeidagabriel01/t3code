import { describe, expect, it } from "vite-plus/test";

import { advanceCpuWindow, CPU_MAX_WINDOW_MS, type CpuReading } from "./HostResources.ts";

const reading = (at: number, idle: number, total: number, count = 8): CpuReading => ({
  at,
  idle,
  total,
  count,
});

describe("advanceCpuWindow", () => {
  const base = reading(0, 100, 1000);
  it.each([
    ["no baseline", null, reading(5_000, 200, 2000), null, "current"],
    ["5s window, 90% busy", base, reading(5_000, 200, 2000), 0.9, "current"],
    ["under the minimum window keeps the baseline", base, reading(1_000, 150, 1200), 0.75, "base"],
    ["core count changed resets", base, reading(5_000, 200, 2000, 4), null, "current"],
    ["stale baseline resets", base, reading(CPU_MAX_WINDOW_MS + 1, 200, 2000), null, "current"],
    ["no ticks elapsed", base, reading(5_000, 100, 1000), null, "current"],
  ] as const)("%s", (_name, baseline, current, utilization, next) => {
    const result = advanceCpuWindow(baseline, current);
    expect(result.utilization).toBeCloseTo(utilization ?? 0);
    if (utilization === null) expect(result.utilization).toBeNull();
    expect(result.next).toBe(next === "base" ? baseline : current);
  });
});
