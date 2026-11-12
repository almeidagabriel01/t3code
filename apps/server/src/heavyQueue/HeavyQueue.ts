/**
 * The machine-wide heavy-work queue, shared with every T3 server and `t3 heavy` CLI on this
 * machine through one file. Agents and the server wait their turn here; only the user reorders.
 */
// @effect-diagnostics nodeBuiltinImport:off - An entry id needs no Effect service.
import * as NodeCrypto from "node:crypto";
import { HeavyQueueError, type HeavyQueueState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { estimate, hasHeadroom, SAMPLE_FRESH_MS, signatureOf } from "./admission.ts";
import * as ClaudeSettingsHook from "./claudeSettingsHook.ts";
import { hookScript, queueBashCall, shellQuote } from "./heavyHook.ts";
import * as QueueFile from "./queueFile.ts";

const POLL_INTERVAL = "1 second";
const STREAM_INTERVAL = "2 seconds";

const failure = (reason: HeavyQueueError["reason"], message: string) =>
  new HeavyQueueError({ reason, message });

const moveFailure = (action: string, result: QueueFile.MoveResult) =>
  result === "ok"
    ? Effect.void
    : Effect.fail(
        result === "running"
          ? failure("running", `The running command cannot be ${action}.`)
          : failure("not-found", "That entry is no longer in the queue."),
      );

const unavailable = (error: unknown) => failure("unavailable", `Heavy queue unavailable: ${error}`);

export class HeavyQueue extends Context.Service<
  HeavyQueue,
  {
    readonly state: Effect.Effect<HeavyQueueState>;
    readonly stream: Stream.Stream<HeavyQueueState>;
    /** Runs a waiter next; `note` records who asked, for agents acting on the user's request. */
    readonly promote: (id: string, note?: string) => Effect.Effect<void, HeavyQueueError>;
    /** The user releases a waiter at once, ignoring slots, load and the pause. Never exposed to agents. */
    readonly startNow: (id: string) => Effect.Effect<void, HeavyQueueError>;
    /** Puts a waiter before `beforeId`, or last when null. */
    readonly move: (id: string, beforeId: string | null) => Effect.Effect<void, HeavyQueueError>;
    /** Removes a waiter, or stops the running `t3 heavy` command. */
    readonly cancel: (id: string) => Effect.Effect<void, HeavyQueueError>;
    /** How many entries may run at once; 1 is strictly one at a time. */
    readonly setMaxRunning: (maxRunning: number) => Effect.Effect<void, HeavyQueueError>;
    readonly setPaused: (paused: boolean) => Effect.Effect<void, HeavyQueueError>;
    /** Off starts every heavy job at once, waiting ones included; on restores the rules for new arrivals. */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void, HeavyQueueError>;
    /** "high" starts a waiter now and lifts a running job's processes out of background QoS; "low" undoes both. */
    readonly setPriority: (
      id: string,
      priority: "low" | "high",
    ) => Effect.Effect<void, HeavyQueueError>;
    /** Adds or removes the queue hook in the user's Claude Code settings. */
    readonly setClaudeHook: (installed: boolean) => Effect.Effect<void, HeavyQueueError>;
    readonly setDeviceIdleMinutes: (minutes: number) => Effect.Effect<void, HeavyQueueError>;
    /** A null priority clears the folder's rule. */
    readonly setRule: (
      root: string,
      priority: "first" | "last" | null,
    ) => Effect.Effect<void, HeavyQueueError>;
    /** Runs `effect` once this server holds the slot; frees it on completion, failure or interrupt. */
    readonly withSlot: <A, E, R>(
      label: string,
      threadId: string | null,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HeavyQueueError, R>;
    /** The shell prefix agents put before a heavy command. */
    readonly command: Effect.Effect<string>;
  }
>()("t3/heavyQueue/HeavyQueue") {}

/** `ps -axo pid=,ppid=` rows to `root` and every process beneath it. */
export const treePids = (ps: string, root: number) => {
  const children = new Map<number, number[]>();
  for (const line of ps.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !(pid > 0) || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const pids = [root];
  for (let index = 0; index < pids.length; index += 1) {
    pids.push(...(children.get(pids[index]!) ?? []));
  }
  return pids;
};

/** This server's own CLI up to `heavy [sub] --queue-dir <dir>`; options and `-- <command>` follow. */
export const queuePrefix = Effect.fn("HeavyQueue.queuePrefix")(function* (
  dir: string,
  sub: ReadonlyArray<string> = [],
) {
  const invocation = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  return [
    // Packaged desktop's executable is Electron, which opens the app instead of running the CLI without this.
    ...(platform === "win32" ? [] : ["ELECTRON_RUN_AS_NODE=1"]),
    shellQuote(invocation.command),
    ...(invocation.entrypoint === undefined ? [] : [shellQuote(invocation.entrypoint)]),
    "heavy",
    ...sub,
    "--queue-dir",
    shellQuote(dir),
  ].join(" ");
});

/** The in-process PreToolUse hook for Claude sessions T3 starts; the queue switched off leaves calls alone. */
export const bashHook =
  (prefix: string, dir: string = QueueFile.defaultQueueDir()) =>
  (hookInput: unknown) =>
    // readDoc never throws: a missing or corrupt file reads as an empty queue that is on.
    QueueFile.readDoc(dir).enabled ? queueBashCall(hookInput, prefix) : null;

const make = Effect.fn("HeavyQueue.make")(function* (dir: string, claudeSettings?: string) {
  const command = `${yield* queuePrefix(dir)} --`;
  const hookCommand = yield* queuePrefix(dir, ["hook"]);
  const settingsPath =
    claudeSettings ?? ClaudeSettingsHook.claudeSettingsPath(yield* HostProcess.Environment);
  const platform = yield* HostProcess.Platform;
  const scriptPath = `${dir}/${ClaudeSettingsHook.HOOK_SCRIPT}`;
  // Windows has no /bin/sh, so Claude Code runs T3 there and pays its startup on every Bash call.
  const settingsCommand = platform === "win32" ? hookCommand : `/bin/sh ${shellQuote(scriptPath)}`;
  const writeScript = () => {
    if (platform !== "win32")
      ClaudeSettingsHook.writeHookScript(scriptPath, hookScript(hookCommand));
  };
  // An update moves the executable; the installed hook follows it from the next start.
  if (ClaudeSettingsHook.readHeavyHookInstalled(settingsPath)) {
    // On failure the script the last install wrote stays; a missing one passes every call through.
    yield* Effect.try({ try: writeScript, catch: (cause) => cause }).pipe(Effect.ignore);
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = (program: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(program, args, { stdin: "ignore", stderr: "ignore" }));
  /** macOS background QoS on every process of a running job; children started later inherit it. */
  const setTreePriority = Effect.fn("HeavyQueue.setTreePriority")(function* (
    root: number,
    priority: "low" | "high",
  ) {
    const pids = treePids(yield* output("/bin/ps", ["-axo", "pid=,ppid="]), root);
    yield* Effect.forEach(
      pids,
      (pid) =>
        output("/usr/sbin/taskpolicy", [priority === "high" ? "-B" : "-b", "-p", String(pid)]).pipe(
          Effect.ignore,
        ),
      { concurrency: 4, discard: true },
    );
  });

  const state = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const { doc, plan } = QueueFile.readPlan(dir, now);
    const { entries, enabled, paused, rules, maxRunning, sample, deviceIdleMinutes } = doc;
    const fresh = sample !== null && now - sample.at <= SAMPLE_FRESH_MS;
    const estimates: Record<string, { cpu: number; memoryBytes: number; durationMs: number }> = {};
    for (const entry of entries) {
      if (entry.startedAt !== null || (doc.history[signatureOf(entry.label)] ?? []).length === 0) {
        continue;
      }
      const usual = estimate(doc.history, entry, 1);
      if (usual.durationMs !== null)
        estimates[entry.id] = { ...usual, durationMs: usual.durationMs };
    }
    return {
      entries,
      estimates,
      enabled,
      paused,
      rules,
      maxRunning,
      reasons: plan.reasons,
      // The label sits beside the CPU reading, so it never says "room" over a busy one.
      room: plan.room && (!fresh || hasHeadroom(sample)),
      claudeHookInstalled: ClaudeSettingsHook.readHeavyHookInstalled(settingsPath),
      deviceIdleMinutes,
      machine: fresh
        ? {
            busyCores: sample.busyCores,
            cpuCount: sample.cpuCount,
            availableMemoryBytes: sample.availableMemoryBytes,
            totalMemoryBytes: sample.totalMemoryBytes,
          }
        : null,
    };
  });

  // A change made here reaches clients at once instead of on the next two-second poll.
  const changed = yield* PubSub.sliding<void>(1);
  const announce = PubSub.publish(changed, undefined);
  const act = (action: string, run: () => QueueFile.MoveResult) =>
    Effect.try({ try: run, catch: unavailable }).pipe(
      Effect.flatMap((result) => moveFailure(action, result)),
      Effect.tap(() => announce),
    );
  const change = (run: () => void) =>
    Effect.try({ try: run, catch: unavailable }).pipe(Effect.tap(() => announce));

  const withSlot = Effect.fnUntraced(function* <A, E, R>(
    label: string,
    threadId: string | null,
    effect: Effect.Effect<A, E, R>,
  ) {
    // Spans would only repeat the one-second poll; the caller's tool span covers the wait.
    const id = NodeCrypto.randomUUID();
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () =>
          QueueFile.enqueue(dir, {
            id,
            pid: process.pid,
            threadId,
            label,
            cwd: process.cwd(),
            createdAt,
            startedAt: null,
            server: true,
          }),
        catch: unavailable,
      }),
      () =>
        Effect.gen(function* () {
          while (true) {
            const start = yield* Effect.try({
              try: () => QueueFile.tryStart(dir, id),
              catch: unavailable,
            });
            if (start.status === "started") break;
            if (start.status === "removed") {
              return yield* failure("not-found", "The user removed this from the heavy queue.");
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
          return yield* effect;
        }),
      () => Effect.sync(() => QueueFile.remove(dir, id)).pipe(Effect.ignore),
    );
  });

  return HeavyQueue.of({
    state,
    stream: Stream.merge(Stream.tick(STREAM_INTERVAL), Stream.fromPubSub(changed)).pipe(
      Stream.mapEffect(() => state),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
    ),
    promote: Effect.fn("HeavyQueue.promote")((id: string, note?: string) =>
      act("promoted", () => QueueFile.promote(dir, id, note)),
    ),
    startNow: Effect.fn("HeavyQueue.startNow")((id: string) =>
      act("started", () => QueueFile.startNow(dir, id)),
    ),
    move: Effect.fn("HeavyQueue.move")((id: string, beforeId: string | null) =>
      act("moved", () => QueueFile.move(dir, id, beforeId, "Moved by the user")),
    ),
    cancel: Effect.fn("HeavyQueue.cancel")((id: string) =>
      act("stopped from here", () => QueueFile.cancel(dir, id)),
    ),
    setMaxRunning: Effect.fn("HeavyQueue.setMaxRunning")((maxRunning: number) =>
      change(() => QueueFile.setMaxRunning(dir, maxRunning)),
    ),
    setPaused: Effect.fn("HeavyQueue.setPaused")((paused: boolean) =>
      change(() => QueueFile.setPaused(dir, paused)),
    ),
    setEnabled: Effect.fn("HeavyQueue.setEnabled")((enabled: boolean) =>
      change(() => QueueFile.setEnabled(dir, enabled)),
    ),
    setPriority: Effect.fn("HeavyQueue.setPriority")(function* (
      id: string,
      priority: "low" | "high",
    ) {
      const { result, entry } = yield* Effect.try({
        try: () => QueueFile.setPriority(dir, id, priority),
        catch: unavailable,
      });
      yield* moveFailure("changed", result);
      // A server-held slot's pid is T3 itself, never lowered.
      if (entry?.startedAt !== null && entry?.server !== true && platform === "darwin") {
        yield* setTreePriority(entry!.pid, priority).pipe(
          Effect.mapError((error) => unavailable(error)),
        );
      }
      yield* announce;
    }),
    setClaudeHook: Effect.fn("HeavyQueue.setClaudeHook")((installed: boolean) =>
      change(() => {
        if (installed) writeScript();
        ClaudeSettingsHook.setHeavyHookInstalled(settingsPath, settingsCommand, installed);
      }),
    ),
    setDeviceIdleMinutes: Effect.fn("HeavyQueue.setDeviceIdleMinutes")((minutes: number) =>
      change(() => QueueFile.setDeviceIdleMinutes(dir, minutes)),
    ),
    setRule: Effect.fn("HeavyQueue.setRule")((root: string, priority: "first" | "last" | null) =>
      change(() => QueueFile.setRule(dir, root, priority)),
    ),
    withSlot,
    command: Effect.succeed(command),
  });
});

/** `claudeSettings` points the hook installer at another file; tests never touch the user's own. */
export const layer = (dir: string = QueueFile.defaultQueueDir(), claudeSettings?: string) =>
  Layer.effect(HeavyQueue, make(dir, claudeSettings));
