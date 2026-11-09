/**
 * Holds the host awake through the OS's own inhibitor while the setting asks for it. The server
 * owns the child it spawns and kills only that child.
 */
import type { KeepAwakeMode, KeepAwakeStatus } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface InhibitorCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** What the machine can do, kept apart so tests can stand in for it. */
export class KeepAwakeHost extends Context.Service<
  KeepAwakeHost,
  { readonly inhibitor: Effect.Effect<Option.Option<InhibitorCommand>> }
>()("t3/keepAwake/KeepAwake/KeepAwakeHost") {}

export const inhibitorFor = (input: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly hasSystemdInhibit: boolean;
}): Option.Option<InhibitorCommand> => {
  if (input.platform === "darwin") {
    return Option.some({
      command: "/usr/bin/caffeinate",
      args: ["-i", "-s", "-w", `${input.pid}`],
    });
  }
  if (input.platform === "linux" && input.hasSystemdInhibit) {
    return Option.some({
      command: "systemd-inhibit",
      args: [
        "--what=idle:sleep",
        "--who=T3 Code",
        "--why=Agents are working",
        "--mode=block",
        "sleep",
        "infinity",
      ],
    });
  }
  return Option.none();
};

export const layerHost = Layer.effect(
  KeepAwakeHost,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const pathVariable = (yield* HostProcess.Environment).PATH ?? "";
    const onPath = (name: string) =>
      Effect.forEach(pathVariable.split(":").filter(Boolean), (dir) =>
        fs.access(path.join(dir, name), { ok: true }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      ).pipe(Effect.map((found) => found.includes(true)));
    return KeepAwakeHost.of({
      inhibitor: Effect.gen(function* () {
        const hasSystemdInhibit = platform === "linux" && (yield* onPath("systemd-inhibit"));
        return inhibitorFor({ platform, pid: process.pid, hasSystemdInhibit });
      }),
    });
  }),
);

export class KeepAwake extends Context.Service<
  KeepAwake,
  {
    readonly streamStatus: Stream.Stream<KeepAwakeStatus>;
  }
>()("t3/keepAwake/KeepAwake") {}

const RESPAWN_MIN = Duration.seconds(1);
const RESPAWN_MAX = Duration.seconds(30);
/** A child that ran this long was healthy, so its next respawn starts from the short delay. */
const HEALTHY_AFTER = Duration.seconds(60);

// Waiting for approval or an answer is not work: the host may sleep until the person returns.
const isWorking = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

const wantsAwake = (mode: KeepAwakeMode, working: number) =>
  mode === "always" || (mode === "while-working" && working > 0);

const make = Effect.gen(function* () {
  const host = yield* KeepAwakeHost;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const inhibitor = yield* host.inhibitor;
  const status = yield* SubscriptionRef.make<KeepAwakeStatus>({
    supported: Option.isSome(inhibitor),
    active: false,
  });
  const mode = yield* SubscriptionRef.make<KeepAwakeMode>("off");
  // Runs, plus provider threads whose turn ended while it waits on a subagent or awaited command.
  const working = yield* Ref.make<ReadonlySet<string>>(new Set());
  const wanted = yield* SubscriptionRef.make(false);

  const setActive = (active: boolean) =>
    SubscriptionRef.update(status, (current) => ({ ...current, active }));

  // Keeps one inhibitor child alive; a child that dies is replaced with a growing delay.
  const hold = Effect.fn("KeepAwake.hold")(function* (command: InhibitorCommand) {
    let delay = RESPAWN_MIN;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      // Inactive is reported only after the scope has killed the child.
      yield* Effect.scoped(
        spawner.spawn(ChildProcess.make(command.command, command.args)).pipe(
          Effect.flatMap((child) => setActive(true).pipe(Effect.andThen(child.exitCode))),
          Effect.catchCause((cause) => Effect.logWarning("keep-awake child failed", { cause })),
        ),
      ).pipe(Effect.ensuring(setActive(false)));
      const lived = (yield* Clock.currentTimeMillis) - startedAt;
      if (lived >= Duration.toMillis(HEALTHY_AFTER)) delay = RESPAWN_MIN;
      yield* Effect.sleep(delay);
      delay = Duration.min(Duration.times(delay, 2), RESPAWN_MAX);
    }
  });

  const refreshWanted = Effect.gen(function* () {
    const wantedNow = wantsAwake(yield* SubscriptionRef.get(mode), (yield* Ref.get(working)).size);
    yield* SubscriptionRef.set(wanted, wantedNow);
  });

  const start = Effect.fn("KeepAwake.start")(function* () {
    const initial = yield* settings.getSettings.pipe(
      Effect.map((current) => current.keepAwake),
      Effect.orElseSucceed(() => "off" as const),
    );
    yield* SubscriptionRef.set(mode, initial);
    const changes = yield* settings.subscribeChanges;
    yield* forkParked(
      Stream.runForEach(changes, (next) =>
        SubscriptionRef.set(mode, next.keepAwake).pipe(Effect.andThen(refreshWanted)),
      ),
    );
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        const entry =
          event.type === "run.created" || event.type === "run.updated"
            ? { key: `run:${event.payload.id}`, on: isWorking(event.payload.status) }
            : event.type === "provider-thread.updated"
              ? {
                  key: `background:${event.payload.id}`,
                  on: backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? []),
                }
              : null;
        if (entry === null) return Effect.void;
        return Ref.update(working, (current) => {
          const next = new Set(current);
          if (entry.on) next.add(entry.key);
          else next.delete(entry.key);
          return next;
        }).pipe(Effect.andThen(refreshWanted));
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("keep-awake events ended", { cause })),
      ),
    );
    yield* refreshWanted;
    if (Option.isNone(inhibitor)) return;
    yield* forkParked(
      SubscriptionRef.changes(wanted).pipe(
        Stream.changes,
        Stream.switchMap((on) => (on ? Stream.fromEffect(hold(inhibitor.value)) : Stream.empty)),
        Stream.runDrain,
      ),
    );
  });

  yield* start();
  return KeepAwake.of({ streamStatus: SubscriptionRef.changes(status) });
});

export const layer = Layer.effect(KeepAwake, make);
