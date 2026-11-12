import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, RUNNER_DEFAULTS } from "@t3tools/contracts";

import { runnerBlockOf, runnerOnAnywhere } from "./RunnerPublisher.ts";

const publisher = { pid: 1, home: "/home", primary: true };
const app = ProjectId.make("app");
const other = ProjectId.make("other");

describe("the Runner block a server publishes", () => {
  it("carries global and machine settings, and each project's override over them", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      runnerOverflow: 4,
      runnerHost: "pc",
      projectSettingsOverrides: {
        [app]: {
          runnerEnabled: true,
          runnerOverflow: 1,
          runnerMacOnly: ["CaptureDevices.test.ts"],
        },
      },
    };
    const block = runnerBlockOf(
      settings,
      [
        { id: app, workspaceRoot: "/code/app" },
        { id: other, workspaceRoot: "/code/other" },
      ],
      publisher,
    );
    expect(block.global).toMatchObject({ runnerEnabled: false, runnerOverflow: 4 });
    expect(block.machine).toEqual({
      runnerHost: "pc",
      runnerLinuxSlots: RUNNER_DEFAULTS.runnerLinuxSlots,
      runnerHeartbeatSeconds: RUNNER_DEFAULTS.runnerHeartbeatSeconds,
      runnerOfflineAfterFailures: RUNNER_DEFAULTS.runnerOfflineAfterFailures,
      runnerSshTimeoutSeconds: RUNNER_DEFAULTS.runnerSshTimeoutSeconds,
      runnerStopWaitSeconds: RUNNER_DEFAULTS.runnerStopWaitSeconds,
    });
    expect(block.projects[0]).toEqual({
      root: "/code/app",
      config: expect.objectContaining({
        runnerEnabled: true,
        runnerOverflow: 1,
        runnerMacOnly: ["CaptureDevices.test.ts"],
        runnerWhere: RUNNER_DEFAULTS.runnerWhere,
      }),
    });
    expect(block.projects[1]!.config).toEqual(block.global);
    expect(runnerOnAnywhere(block)).toBe(true);
    expect(runnerOnAnywhere({ ...block, projects: [block.projects[1]!] })).toBe(false);
  });
});
