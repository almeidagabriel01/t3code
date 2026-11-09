import { describe, expect, it } from "@effect/vitest";

import { heavyEntryName } from "./heavyEntryName.ts";

describe("heavyEntryName", () => {
  it.each([
    [{ name: " Build iPhone ", label: "xcodebuild", cwd: "/a" }, "Build iPhone"],
    [{ label: "vp test run src/auth", cwd: "/r/apps/server" }, "Tests · server"],
    [{ label: "npx vp test run src/x", cwd: "/r/packages/shared/" }, "Tests · shared"],
    [{ label: "vp run mobile:install ios", cwd: "/r" }, "Install iOS app"],
    [{ label: "vp run mobile:install android 1", cwd: "/r" }, "Install Android app"],
    [{ label: "vp run typecheck", cwd: "/r/apps/web" }, "Typecheck · web"],
    [{ label: "vp run check:changed", cwd: "/r" }, "Changed checks"],
    [{ label: "/tmp/scratch/gate.sh --all now please", cwd: "/r" }, "gate.sh --all now"],
    [{ label: `cargo ${"x".repeat(60)}`, cwd: "/r" }, `cargo ${"x".repeat(25)}…`],
    [{ name: undefined, label: "", cwd: "/" }, ""],
  ])("%j", (entry, expected) => {
    expect(heavyEntryName(entry)).toBe(expected);
  });
});
