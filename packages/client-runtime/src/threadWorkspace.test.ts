import { describe, expect, it } from "vite-plus/test";

import { describeCleanedWorkspace, missingRepositoryAction } from "./threadWorkspace.ts";

describe("describeCleanedWorkspace", () => {
  it("says no changes remain when the snapshot is missing or expired", () => {
    expect(describeCleanedWorkspace({ state: "cleaned", snapshot: null })).toContain(
      "No saved changes remain",
    );
  });

  it("names the day the changes were saved", () => {
    const text = describeCleanedWorkspace({
      state: "cleaned",
      snapshot: { capturedAt: "2026-11-01T12:00:00.000Z" },
    });
    expect(text).toContain("brings back the changes saved on");
    expect(text).toMatch(/saved on .*2026/);
  });
});

describe("missingRepositoryAction", () => {
  const ready = { state: "ready", snapshot: null } as const;
  const cleaned = { state: "cleaned", snapshot: null } as const;
  it.each([
    ["a cleaned worktree", { hasWorktree: true, status: cleaned }, "restore"],
    ["a worktree whose status is unknown", { hasWorktree: true, status: null }, "none"],
    ["a ready worktree with a stale git reading", { hasWorktree: true, status: ready }, "none"],
    ["a thread on the project folder", { hasWorktree: false, status: null }, "initialize"],
  ] as const)("offers the right action for %s", (_name, input, expected) => {
    expect(missingRepositoryAction(input)).toBe(expected);
  });
});
