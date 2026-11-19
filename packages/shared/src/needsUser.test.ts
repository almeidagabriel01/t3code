import { describe, expect, it } from "vite-plus/test";

import { decisionWaitsOnUser, requestWaitsOnUser } from "./needsUser.ts";

describe("needsUser", () => {
  it.each([
    ["command", true],
    ["file-change", true],
    ["user_input", true],
    ["dynamic_tool_call", false],
    ["auth_refresh", false],
  ])("a pending %s request waits on the user: %s", (kind, waits) => {
    expect(requestWaitsOnUser(kind)).toBe(waits);
  });

  it.each([
    [{}, true],
    [{ notice: true as const }, false],
    [{ approvalRequestId: "r1" }, false],
  ])("decision %o waits on the user: %s", (decision, waits) => {
    expect(decisionWaitsOnUser(decision)).toBe(waits);
  });
});
