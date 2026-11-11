import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_USE_CAPABILITY_LABELS,
  computerUseCapabilityStateLabel,
  computerUseHostLabel,
  isComputerUseHostOs,
} from "./macPermissions.ts";

describe("computer use host report", () => {
  it.each([
    [{ os: "win32" }, "Windows"],
    [{ os: "linux", display: "x11" }, "Linux, X11 session"],
    [{ os: "linux", display: "wayland" }, "Linux, Wayland session"],
    [{ os: "linux", display: "none" }, "Linux, no desktop session"],
    [{ os: "linux" }, "Linux, no desktop session"],
  ] as const)("names the host %o as %s", (host, label) => {
    expect(computerUseHostLabel({ ...host, capabilities: [] })).toBe(label);
  });

  it("only Windows and Linux hosts report capabilities; a Mac has permissions instead", () => {
    expect(["win32", "linux", "darwin", "freebsd", undefined].filter(isComputerUseHostOs)).toEqual([
      "win32",
      "linux",
    ]);
  });

  it("every capability and state has its own words", () => {
    const states = (["available", "consent", "limited", "unavailable"] as const).map(
      computerUseCapabilityStateLabel,
    );
    expect(new Set(states).size).toBe(4);
    expect(new Set(Object.values(COMPUTER_USE_CAPABILITY_LABELS)).size).toBe(4);
  });
});
