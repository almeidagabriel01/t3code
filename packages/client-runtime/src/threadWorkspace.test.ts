import { describe, expect, it } from "vite-plus/test";

import { describeCleanedWorkspace } from "./threadWorkspace.ts";

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
