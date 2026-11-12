// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  RUNNER_DEFAULTS,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as QueueFile from "./queueFile.ts";
import { layer, runnerBlockOf, runnerOnAnywhere } from "./RunnerPublisher.ts";
import type { HealthCheck } from "./runner.ts";

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

describe("the publisher layer", () => {
  it.effect(
    "publishes on start, checks Linux while the Runner is on, and republishes each tick",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runner-pub-"));
        let settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, runnerEnabled: true };
        const checks = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        let calls = 0;
        const check = async (): Promise<HealthCheck> => {
          Deferred.doneUnsafe(checks[Math.min(calls, 1)]!, Effect.void);
          calls += 1;
          return {
            ok: true,
            reading: { load1: 1, cpuCount: 6, totalMemoryBytes: 8, availableMemoryBytes: 4 },
          };
        };
        const services = Layer.mergeAll(
          Layer.succeed(ServerSettingsService, {
            getSettings: Effect.sync(() => settings),
            streamChanges: Stream.empty,
          } as unknown as ServerSettingsService["Service"]),
          Layer.succeed(ProjectStoreV2, {
            list: () =>
              Effect.succeed([
                { projectId: "app", workspaceRoot: "/w/app", archivedAt: null },
                {
                  projectId: "old",
                  workspaceRoot: "/w/old",
                  archivedAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
          } as unknown as ProjectStoreV2["Service"]),
          Layer.succeed(ServerConfig, { baseDir: dir } as unknown as ServerConfig["Service"]),
        );
        yield* Effect.gen(function* () {
          yield* Layer.build(layer(dir, check).pipe(Layer.provide(services)));
          yield* Deferred.await(checks[0]!);
          settings = { ...settings, runnerHost: "pc" };
          yield* TestClock.adjust(`${RUNNER_DEFAULTS.runnerHeartbeatSeconds} seconds`);
          yield* Deferred.await(checks[1]!);
        }).pipe(Effect.scoped);
        const doc = QueueFile.readDoc(dir);
        expect(doc.runner?.publisher).toMatchObject({
          pid: process.pid,
          home: dir,
          primary: false,
        });
        expect(doc.runner?.machine.runnerHost).toBe("pc");
        expect(doc.runner?.projects.map((project) => project.root)).toEqual(["/w/app"]);
        expect(doc.linux).toMatchObject({ online: true, load1: 1 });
      }),
  );
});
