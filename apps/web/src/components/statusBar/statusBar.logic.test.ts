import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCompactCountdown,
  formatMemory,
  portAddress,
  selectBarWindows,
  sparklinePoints,
} from "./statusBar.logic";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("formatCompactCountdown", () => {
  it("compacts hours, days and minutes", () => {
    expect(formatCompactCountdown(at((3 * 60 + 49) * 60_000 + 5_000), NOW)).toBe("3h49m");
    expect(formatCompactCountdown(at((3 * 24 + 12) * 3_600_000 + 60_000), NOW)).toBe("3d12h");
    expect(formatCompactCountdown(at(12 * 60_000), NOW)).toBe("12m");
  });

  it("handles missing, invalid and elapsed resets", () => {
    expect(formatCompactCountdown(undefined, NOW)).toBeNull();
    expect(formatCompactCountdown("soon", NOW)).toBeNull();
    expect(formatCompactCountdown(at(-1_000), NOW)).toBe("now");
  });
});

describe("selectBarWindows", () => {
  const window = (id: string, kind: ServerProviderUsageWindow["kind"]): ServerProviderUsageWindow =>
    ({ id, kind, label: id, usedPercent: 10 }) as ServerProviderUsageWindow;

  it("leads with session and weekly, leaving other windows as extras", () => {
    const windows = [window("opus", "weekly"), window("s", "session"), window("w", "weekly")];
    const { primary, extra } = selectBarWindows([windows[1]!, windows[0]!, windows[2]!]);
    expect(primary.map((w) => w.id)).toEqual(["s", "opus"]);
    expect(extra.map((w) => w.id)).toEqual(["w"]);
  });
});

describe("formatMemory", () => {
  it("switches between MB and GB", () => {
    expect(formatMemory(4.04 * 1024 ** 3)).toBe("4.04 GB");
    expect(formatMemory(512 * 1024 ** 2)).toBe("512 MB");
  });
});

describe("sparklinePoints", () => {
  it("scales to the series max, newest sample rightmost", () => {
    expect(sparklinePoints([0, 5, 10], 100, 20)).toBe("0.0,20.0 50.0,10.0 100.0,0.0");
  });

  it("draws nothing without a line to draw", () => {
    expect(sparklinePoints([4], 100, 20)).toBe("");
    expect(sparklinePoints([], 100, 20)).toBe("");
  });
});

describe("portAddress", () => {
  it("names loopback and wildcard binds localhost and keeps real hosts", () => {
    expect(portAddress("*", 3000)).toBe("localhost:3000");
    expect(portAddress("::1", 3000)).toBe("localhost:3000");
    expect(portAddress("192.168.1.5", 80)).toBe("192.168.1.5:80");
    expect(portAddress("fe80:0:0:0:1:2:3:4", 80)).toBe("[fe80:0:0:0:1:2:3:4]:80");
  });
});
