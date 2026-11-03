import { describe, expect, it } from "vite-plus/test";

import { sideChatParentStatus } from "./models.ts";

const idle = {
  runtime: null,
  latestRun: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  goal: null,
};
type Parent = Parameters<typeof sideChatParentStatus>[0];
const parent = (patch: object) => ({ ...idle, ...patch }) as Parent;

describe("sideChatParentStatus", () => {
  it.each([
    [
      "approval wins over a running turn",
      { hasPendingApprovals: true, runtime: { status: "running" } },
      "Needs approval",
      "attention",
    ],
    ["pending input", { hasPendingUserInput: true }, "Needs input", "attention"],
    ["preparing", { runtime: { status: "preparing" } }, "Starting", "active"],
    ["queued", { runtime: { status: "queued" } }, "Starting", "active"],
    ["starting", { runtime: { status: "starting" } }, "Starting", "active"],
    ["running", { runtime: { status: "running" } }, "Working", "active"],
    ["waiting", { runtime: { status: "waiting" } }, "Working", "active"],
    ["paused goal", { goal: { status: "paused" } }, "Goal paused", "attention"],
    ["interrupted run", { latestRun: { status: "interrupted" } }, "Interrupted", "idle"],
    ["failed run", { latestRun: { status: "failed" } }, "Failed", "error"],
    ["completed run", { latestRun: { status: "completed" } }, "Idle", "idle"],
    ["nothing yet", {}, "Idle", "idle"],
  ])("%s", (_name, patch, label, tone) => {
    expect(sideChatParentStatus(parent(patch))).toEqual({ label, tone });
  });
});
