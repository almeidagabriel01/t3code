import { describe, expect, it } from "vite-plus/test";

import { forkUpdateAction, shouldNotifyForkUpdate } from "./forkUpdates.logic";

const status = { available: true, behind: 4, headTag: "v1.0.0", upstreamTag: "v1.1.0" };

describe("shouldNotifyForkUpdate", () => {
  it("notifies for a new unmerged release", () => {
    expect(shouldNotifyForkUpdate(status, "")).toBe(true);
  });

  it("stays quiet when dismissed, merged, unavailable or not behind", () => {
    expect(shouldNotifyForkUpdate(status, "v1.1.0")).toBe(false);
    expect(shouldNotifyForkUpdate({ ...status, headTag: "v1.1.0" }, "")).toBe(false);
    expect(shouldNotifyForkUpdate({ ...status, available: false }, "")).toBe(false);
    expect(shouldNotifyForkUpdate({ ...status, behind: 0 }, "")).toBe(false);
    expect(shouldNotifyForkUpdate({ ...status, upstreamTag: null }, "")).toBe(false);
  });
});

describe("forkUpdateAction", () => {
  const base = { available: true, behind: 3, wouldConflict: false as boolean | null };
  it.each([
    ["up to date", { ...base, behind: 0 }, true, "none"],
    ["no checkout", { ...base, available: false }, true, "none"],
    ["no project for the checkout", base, false, "add-project"],
    ["clean merge", base, true, "update"],
    ["unknown merge result", { ...base, wouldConflict: null }, true, "update"],
    ["conflicting merge", { ...base, wouldConflict: true }, true, "resolve"],
  ] as const)("%s", (_name, status, hasProject, action) => {
    expect(forkUpdateAction(status, hasProject)).toBe(action);
  });
});
