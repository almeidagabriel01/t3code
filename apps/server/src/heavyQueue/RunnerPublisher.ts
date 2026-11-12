/**
 * Mirrors the Runner settings into the queue file, where the `t3 heavy` CLI and every waiter read
 * them, and runs the Linux heartbeat. Settings stay the source; the file carries each project's
 * effective values so admission resolves a folder without a server.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  HeavyQueueError,
  RUNNER_DEFAULTS,
  RUNNER_MACHINE_KEYS,
  RUNNER_PROJECT_KEYS,
  type RunnerMachineConfig,
  type RunnerProjectConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as QueueFile from "./queueFile.ts";
import type { RunnerBlock } from "./runner.ts";
import { checkLinux } from "./runnerExec.ts";

const pick = <K extends string>(
  source: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<K>,
) => Object.fromEntries(keys.map((key) => [key, source[key]])) as Record<K, unknown>;

/** The block for these settings and projects; pure so the publish rules are testable. */
export const runnerBlockOf = (
  settings: ServerSettings,
  projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>,
  publisher: RunnerBlock["publisher"],
): RunnerBlock => ({
  global: pick(settings, RUNNER_PROJECT_KEYS) as unknown as RunnerProjectConfig,
  machine: pick(settings, RUNNER_MACHINE_KEYS) as unknown as RunnerMachineConfig,
  projects: projects.map((project) => ({
    root: project.workspaceRoot,
    config: pick(
      resolveProjectSettings(settings, project.id as never).settings,
      RUNNER_PROJECT_KEYS,
    ) as unknown as RunnerProjectConfig,
  })),
  publisher,
});

const fingerprint = (block: RunnerBlock) => JSON.stringify(block);

export const runnerOnAnywhere = (block: RunnerBlock) =>
  block.global.runnerEnabled || block.projects.some((project) => project.config.runnerEnabled);

export const layer = (dir: string = QueueFile.defaultQueueDir()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      const projectStore = yield* ProjectStoreV2;
      const config = yield* ServerConfig;
      const publisher: RunnerBlock["publisher"] = {
        pid: process.pid,
        home: config.baseDir,
        primary: NodePath.resolve(config.baseDir) === NodePath.resolve(NodeOS.homedir(), ".t3"),
      };
      let lastPublished = "";
      let owner = false;
      let current: RunnerBlock | null = null;

      const publish = Effect.fn("RunnerPublisher.publish")(function* (settings: ServerSettings) {
        const projects = yield* projectStore.list();
        const block = runnerBlockOf(
          settings,
          projects
            .filter((project) => project.archivedAt === null)
            .map((project) => ({ id: project.projectId, workspaceRoot: project.workspaceRoot })),
          publisher,
        );
        current = block;
        const text = fingerprint(block);
        // Unchanged settings never touch the file; ownership is re-checked on each write.
        if (text === lastPublished && owner) return;
        owner = QueueFile.publishRunner(dir, block);
        if (owner) lastPublished = text;
      });

      yield* settingsService.getSettings.pipe(
        Effect.flatMap(publish),
        Effect.ignore({ log: true }),
      );
      yield* settingsService.streamChanges.pipe(
        Stream.runForEach((settings) => publish(settings).pipe(Effect.ignore({ log: true }))),
        Effect.forkScoped,
      );

      // Projects come and go without a settings change; re-resolve on every heartbeat tick.
      const tick = Effect.gen(function* () {
        yield* settingsService.getSettings.pipe(
          Effect.flatMap(publish),
          Effect.ignore({ log: true }),
        );
        const block = current;
        if (block === null || !owner || !runnerOnAnywhere(block)) return;
        const check = yield* Effect.promise(() => checkLinux(block.machine, process.env));
        yield* Effect.try({
          try: () => QueueFile.recordHealth(dir, check),
          catch: (cause) => new HeavyQueueError({ reason: "unavailable", message: String(cause) }),
        }).pipe(Effect.ignore);
      });
      yield* tick.pipe(
        Effect.andThen(
          Effect.suspend(() =>
            Effect.sleep(
              `${current?.machine.runnerHeartbeatSeconds ?? RUNNER_DEFAULTS.runnerHeartbeatSeconds} seconds`,
            ),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );
