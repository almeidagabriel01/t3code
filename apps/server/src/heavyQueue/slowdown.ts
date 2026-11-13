/**
 * While this Mac stays over its CPU ceiling, agents' running jobs drop to background CPU priority
 * (`taskpolicy -b`), their whole tree and the daemons working for them; once there is room again
 * for them at full speed, they come back. The user's own jobs, and any job whose priority the user
 * set, are never touched. Pure: the sampler applies the step and records it.
 */
import {
  HEAVY_SLOW_AGENT_JOBS_DEFAULT,
  type HeavyQueueEntry,
  type ResourceTelemetryProcess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SAMPLE_FRESH_MS, type Sample } from "./admission.ts";
import { childrenByParent, treeUsage } from "./classifyHeavyCommands.ts";
import type { ProcessIdentity } from "./queueFile.ts";
import type { RunnerBlock } from "./runner.ts";

export interface SlowdownStep {
  readonly slowed: ReadonlyArray<string>;
  readonly restored: ReadonlyArray<string>;
  /** Pids to lower to background, and to bring back to normal. */
  readonly lower: ReadonlyArray<number>;
  readonly raise: ReadonlyArray<number>;
  /** Daemons held lowered after this step. */
  readonly slowedDaemons: ReadonlyArray<ProcessIdentity>;
}

/** An agent's job (the "low" lane agents queue in) that T3 runs and may slow down. */
const slowable = (entry: HeavyQueueEntry) =>
  entry.startedAt !== null &&
  entry.runner !== "linux" &&
  entry.server !== true &&
  entry.ungated !== true &&
  entry.priority === "low" &&
  // Already in the background by the user's own choice: leave it there.
  (entry.slowed === true || entry.qos !== "background");

const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) =>
  a.pid === b.pid && a.startTimeMs === b.startTimeMs;

export const slowdownStep = (
  doc: {
    readonly entries: ReadonlyArray<HeavyQueueEntry>;
    readonly sample: Sample | null;
    readonly runner: Pick<RunnerBlock, "machine"> | null;
    readonly slowedDaemons: ReadonlyArray<ProcessIdentity>;
  },
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  now: number,
): SlowdownStep => {
  const on =
    (doc.runner?.machine.heavySlowAgentJobs ?? HEAVY_SLOW_AGENT_JOBS_DEFAULT) &&
    doc.sample !== null &&
    now - doc.sample.at <= SAMPLE_FRESH_MS &&
    doc.sample.slow?.overLimit === true;
  const children = childrenByParent(processes);
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const tree = (entry: HeavyQueueEntry) => {
    const root = byPid.get(entry.pid);
    return root === undefined ? [] : treeUsage(root, children).pids;
  };
  const targets = on ? doc.entries.filter(slowable) : [];
  const slowed = targets.filter((entry) => entry.slowed !== true);
  const restored = doc.entries.filter((entry) => entry.slowed === true && !targets.includes(entry));
  const slowedDaemons = targets.flatMap((entry) =>
    (entry.daemons ?? []).flatMap((pid) => {
      const process = byPid.get(pid);
      return process === undefined ? [] : [process.identity];
    }),
  );
  const held = (identity: ProcessIdentity) =>
    doc.slowedDaemons.some((lowered) => sameProcess(lowered, identity));
  const alive = (identity: ProcessIdentity) => {
    const process = byPid.get(identity.pid);
    return process !== undefined && sameProcess(process.identity, identity);
  };
  return {
    slowed: slowed.map((entry) => entry.id),
    restored: restored.map((entry) => entry.id),
    lower: [
      ...slowed.flatMap(tree),
      ...slowedDaemons.filter((identity) => !held(identity)).map((identity) => identity.pid),
    ],
    raise: [
      ...restored.flatMap(tree),
      ...doc.slowedDaemons
        .filter(
          (identity) =>
            alive(identity) && !slowedDaemons.some((kept) => sameProcess(kept, identity)),
        )
        .map((identity) => identity.pid),
    ],
    slowedDaemons,
  };
};

export const isNoop = (step: SlowdownStep, before: ReadonlyArray<ProcessIdentity>) =>
  step.slowed.length === 0 &&
  step.restored.length === 0 &&
  step.lower.length === 0 &&
  step.raise.length === 0 &&
  step.slowedDaemons.length === before.length;

/** Applies a step's CPU priorities with macOS `taskpolicy`; a process that already exited is skipped. */
export const applySlowdown = Effect.fn("HeavyQueueSlowdown.apply")(function* (step: SlowdownStep) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const set = (flag: "-b" | "-B") => (pid: number) =>
    spawner
      .string(
        ChildProcess.make("/usr/sbin/taskpolicy", [flag, "-p", String(pid)], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.ignore);
  // A few at a time: a big build tree should not spawn a burst of processes on a Mac already busy.
  yield* Effect.forEach(step.lower, set("-b"), { concurrency: 4, discard: true });
  yield* Effect.forEach(step.raise, set("-B"), { concurrency: 4, discard: true });
});
