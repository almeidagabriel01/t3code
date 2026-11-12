// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { describe, expect, it } from "@effect/vitest";

import { parseDarwinMemory, parseLinuxMemory, readMemorySync, swapInRate } from "./hostReader.ts";

const GIB = 1024 ** 3;
const PAGE = 16384;

// Shape of a real `vm_stat` on a 16 GB M-series Mac under pressure.
const vmStat = (pages: {
  free: number;
  inactive: number;
  anonymous: number;
  purgeable: number;
  wired: number;
  compressor: number;
  swapins: number;
}) => `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)
Pages free:                                     ${pages.free}.
Pages active:                                 153599.
Pages inactive:                               ${pages.inactive}.
Pages speculative:                              3394.
Pages wired down:                             ${pages.wired}.
Pages purgeable:                                   ${pages.purgeable}.
File-backed pages:                            114173.
Anonymous pages:                              ${pages.anonymous}.
Pages stored in compressor:                   799768.
Pages occupied by compressor:                 ${pages.compressor}.
Swapins:                                   ${pages.swapins}.
Swapouts:                                  403750347.
`;

describe("host memory reading", () => {
  it("counts the compressor and wired memory as used, so a thrashing Mac does not read ~30% free", () => {
    const pages = {
      // free + inactive alone is ~29% of 16 GiB: what the old reading called available.
      free: 8213,
      inactive: 296000,
      anonymous: 191970,
      purgeable: 4,
      wired: 261903,
      compressor: 432742,
      swapins: 1000,
    };
    const reading = parseDarwinMemory(vmStat(pages), "2\n", 16 * GIB);
    const used = (191970 - 4 + 261903 + 432742) * PAGE;
    expect(reading).toEqual({
      availableMemoryBytes: 16 * GIB - used,
      totalMemoryBytes: 16 * GIB,
      pressureLevel: 2,
      swapInBytes: 1000 * PAGE,
    });
    expect(reading!.availableMemoryBytes / (16 * GIB)).toBeLessThan(0.16);
  });

  it.each([
    ["no page size", "Anonymous pages: 1.\n", "1"],
    ["a missing counter", `page size of ${PAGE} bytes\nAnonymous pages: 1.\n`, "1"],
  ])("rejects vm_stat output with %s", (_why, text, pressure) => {
    expect(parseDarwinMemory(text, pressure, GIB)).toBeNull();
  });

  it("clamps to the machine and leaves unknown pressure and swap null", () => {
    const text = vmStat({
      free: 0,
      inactive: 0,
      anonymous: 0,
      purgeable: 10,
      wired: 0,
      compressor: 0,
      swapins: 0,
    }).replace(/^Swapins.*$/m, "");
    expect(parseDarwinMemory(text, "", GIB)).toEqual({
      availableMemoryBytes: GIB,
      totalMemoryBytes: GIB,
      pressureLevel: null,
      swapInBytes: null,
    });
  });

  it("reads Linux MemAvailable and pswpin pages", () => {
    expect(
      parseLinuxMemory("MemTotal: 100 kB\nMemAvailable:    2048 kB\n", "pswpin 10\n", GIB),
    ).toEqual({
      availableMemoryBytes: 2048 * 1024,
      totalMemoryBytes: GIB,
      pressureLevel: null,
      swapInBytes: 40960,
    });
    expect(parseLinuxMemory("MemTotal: 100 kB\n", "", GIB)).toBeNull();
    expect(parseLinuxMemory("MemAvailable: 1 kB\n", "", GIB)?.swapInBytes).toBeNull();
  });

  it.each([
    ["no previous reading", null, { at: 2000, swapInBytes: 10 }, null],
    ["unknown counters", { at: 0, swapInBytes: null }, { at: 2000, swapInBytes: 10 }, null],
    ["no time passed", { at: 2000, swapInBytes: 0 }, { at: 2000, swapInBytes: 10 }, null],
    ["a counter reset reads as none", { at: 0, swapInBytes: 50 }, { at: 1000, swapInBytes: 10 }, 0],
    ["bytes per second", { at: 0, swapInBytes: 0 }, { at: 2000, swapInBytes: 4096 }, 2048],
  ] as const)("swap-in rate: %s", (_why, previous, current, rate) => {
    expect(swapInRate(previous, current)).toBe(rate);
  });

  it("reads this machine without throwing, with kernel signals on macOS", () => {
    const reading = readMemorySync();
    expect(reading.totalMemoryBytes).toBeGreaterThan(0);
    expect(reading.availableMemoryBytes).toBeLessThanOrEqual(reading.totalMemoryBytes);
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Asserts on the real host this runs on.
    if (NodeOS.platform() === "darwin") {
      expect(reading.pressureLevel).toBeGreaterThanOrEqual(1);
      expect(reading.swapInBytes).not.toBeNull();
    }
    expect(readMemorySync("win32").pressureLevel).toBeNull();
  });
});
