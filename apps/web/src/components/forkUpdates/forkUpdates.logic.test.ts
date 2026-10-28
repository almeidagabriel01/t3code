import { describe, expect, it } from "vite-plus/test";

import { shouldNotifyForkUpdate } from "./forkUpdates.logic";

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
