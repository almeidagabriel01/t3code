import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatMemory,
  portAddress,
  selectChipEntries,
  selectBarWindows,
  sparklinePoints,
} from "./statusBar.logic";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

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

describe("selectChipEntries", () => {
  const w = (
    id: string,
    kind: ServerProviderUsageWindow["kind"],
    usedPercent: number,
    resetsAt?: string,
    label = `${id} label`,
  ): ServerProviderUsageWindow =>
    ({ id, kind, label, usedPercent, resetsAt }) as ServerProviderUsageWindow;
  const summary = (windows: ServerProviderUsageWindow[], mode: "verbose" | "compact") =>
    selectChipEntries(windows, mode, NOW).map((e) => [e.window.id, e.bar, e.name, e.resets]);

  it.each([
    {
      name: "session and weekly each get a bar and a plain name; only the session shows time left",
      windows: [w("s", "session", 45, at(2 * 3_600_000)), w("w", "weekly", 30, at(3 * 86_400_000))],
      mode: "verbose" as const,
      expected: [
        ["s", true, "Session", "2h0m"],
        ["w", true, "Week", null],
      ],
    },
    {
      name: "a session without a reset time shows no time left",
      windows: [w("s", "session", 45)],
      mode: "verbose" as const,
      expected: [["s", true, "Session", null]],
    },
    {
      name: "a model's own weekly limit reads as the model, text only",
      windows: [
        w("s", "session", 5),
        w("w", "weekly", 5, undefined, "Weekly"),
        w("fable", "weekly", 0, undefined, "Weekly · Fable"),
        w("credit", "monthly", 3, undefined, "Monthly credit limit"),
      ],
      mode: "verbose" as const,
      expected: [
        ["s", true, "Session", null],
        ["w", true, "Week", null],
        ["fable", false, "Fable", null],
        ["credit", false, "Month", null],
      ],
    },
    {
      name: "compact keeps only the tightest window, no bar",
      windows: [w("s", "session", 10, at(12 * 60_000)), w("w", "weekly", 80)],
      mode: "compact" as const,
      expected: [["w", false, "Week", null]],
    },
    {
      name: "compact shows the time left of the tightest window",
      windows: [w("s", "session", 90, at(12 * 60_000)), w("w", "weekly", 80)],
      mode: "compact" as const,
      expected: [["s", false, "Session", "12m"]],
    },
    {
      name: "a window of another kind keeps its own label",
      windows: [w("o", "other", 20, undefined, "Credits")],
      mode: "compact" as const,
      expected: [["o", false, "Credits", null]],
    },
    { name: "no windows", windows: [], mode: "verbose" as const, expected: [] },
  ])("$name", ({ windows, mode, expected }) => {
    expect(summary(windows, mode)).toEqual(expected);
  });
});
