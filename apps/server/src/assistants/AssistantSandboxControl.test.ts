import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PeerLinkError,
  type PeerLink,
  type PeerLinkCreateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Directory from "./AssistantDirectory.ts";
import * as AssistantSandbox from "./AssistantSandbox.ts";
import * as Control from "./AssistantSandboxControl.ts";

const sandboxId = EnvironmentId.make("environment-sandbox");
const url = "http://127.0.0.1:49152";

interface World {
  container: AssistantSandbox.AssistantSandboxState;
  /** What the sandbox's own server reports once it answers. */
  url: string | null;
  ensureError: string | null;
  linkError: string | null;
  links: Map<string, PeerLink>;
  linked: Array<{ readonly url: string; readonly code: string; readonly access: string }>;
  unlinked: string[];
  removed: boolean[];
  /** The limit each `ensure` and `setCpus` was given. */
  ensured: Array<number | null>;
  limits: Array<number | null>;
}

const harness = (
  initial: Partial<World> = {},
  settings: { linked: boolean } = { linked: true },
) => {
  const world: World = {
    container: "missing",
    url: null,
    ensureError: null,
    linkError: null,
    links: new Map(),
    linked: [],
    unlinked: [],
    removed: [],
    ensured: [],
    limits: [],
    ...initial,
  };
  const status = () =>
    ({
      state: world.container,
      url: world.container === "running" ? world.url : null,
    }) satisfies AssistantSandbox.AssistantSandboxStatus;
  const sandbox = Layer.succeed(AssistantSandbox.AssistantSandbox, {
    status: Effect.sync(status),
    ensure: (cpus) =>
      Effect.suspend(() => {
        world.ensured.push(cpus);
        if (world.ensureError !== null) {
          return Effect.fail(
            new AssistantSandbox.AssistantSandboxError({
              reason: "docker_failed",
              message: world.ensureError,
            }),
          );
        }
        if (world.container !== "running") {
          world.container = "running";
          world.url = url;
        }
        return Effect.sync(status);
      }),
    setCpus: (cpus) => Effect.sync(() => void world.limits.push(cpus)),
    stop: Effect.sync(() => {
      world.container = "stopped";
      return status();
    }),
    remove: ({ deleteVolumes }) =>
      Effect.sync(() => {
        world.removed.push(deleteVolumes);
        world.container = "missing";
        return status();
      }),
    pairingCredential: Effect.succeed(Redacted.make("PAIRCODE")),
  });
  const peerLinks = Layer.effect(
    PeerLinks.PeerLinks,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      return PeerLinks.PeerLinks.of({
        enabled: serverSettings.getSettings.pipe(
          Effect.map((value) => value.linkedEnvironmentsEnabled),
          Effect.orDie,
        ),
        describe: () => Effect.succeedSome({ environmentId: sandboxId, label: "box" }),
        get: (environmentId: EnvironmentId) =>
          Effect.succeed(Option.fromNullishOr(world.links.get(environmentId))),
        link: (input: PeerLinkCreateInput) =>
          Effect.gen(function* () {
            if (world.linkError !== null) {
              return yield* new PeerLinkError({
                reason: "pairing_rejected",
                message: world.linkError,
              });
            }
            world.linked.push({
              url: input.url,
              code: input.pairingCode,
              access: input.access,
            });
            const now = yield* DateTime.now;
            const link: PeerLink = {
              environmentId: sandboxId,
              label: "box",
              urls: [input.url],
              access: input.access,
              linkedAt: now,
              expiresAt: DateTime.add(now, { days: 30 }),
              lastReachedAt: now,
              lastError: null,
            };
            world.links.set(sandboxId, link);
            return link;
          }),
        unlink: (environmentId: EnvironmentId) =>
          Effect.sync(() => {
            world.unlinked.push(environmentId);
            return world.links.delete(environmentId);
          }),
      } as never);
    }),
  );
  const layer = Control.layer.pipe(
    Layer.provideMerge(Directory.layer),
    Layer.provide(sandbox),
    Layer.provide(peerLinks),
    Layer.provideMerge(ServerSettings.layerTest({ linkedEnvironmentsEnabled: settings.linked })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  return { world, layer };
};

/** Starts the sandbox and waits for the background start to finish. */
const started = Effect.gen(function* () {
  const control = yield* Control.AssistantSandboxControl;
  const first = yield* control.start;
  assert.strictEqual(first.state, "starting");
  return yield* control.streamStatus.pipe(
    Stream.filter((status) => status.state !== "starting"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
});

it.effect("start builds, links with a fresh credential and records the sandbox", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const directory = yield* Directory.AssistantDirectory;
    assert.isTrue(Option.isNone(yield* directory.sandboxEnvironmentId));
    const ready = yield* started;
    assert.deepInclude(ready, { state: "running", environmentId: sandboxId, error: null });
    assert.deepStrictEqual(world.linked, [{ url, code: "PAIRCODE", access: "full-access" }]);
    assert.strictEqual(Option.getOrNull(yield* directory.sandboxEnvironmentId), sandboxId);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "start turns on Linked environments only when it is off and says so in the status",
  () => {
    const off = harness({}, { linked: false });
    return Effect.gen(function* () {
      const control = yield* Control.AssistantSandboxControl;
      assert.isFalse((yield* control.status).linkedEnvironmentsEnabled);
      const ready = yield* started;
      assert.isTrue(ready.linkedEnvironmentsEnabled);
      assert.strictEqual(ready.state, "running");
    }).pipe(Effect.provide(off.layer));
  },
);

it.effect("start reuses a live link to the sandbox and relinks when its address changed", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    yield* started;
    assert.strictEqual(world.linked.length, 1);
    // Already running and linked: another start links nothing.
    const control = yield* Control.AssistantSandboxControl;
    yield* control.start;
    yield* control.streamStatus.pipe(
      Stream.filter((status) => status.state !== "starting"),
      Stream.runHead,
    );
    assert.strictEqual(world.linked.length, 1);
    // The container came back on another port: the old link would point nowhere.
    world.url = "http://127.0.0.1:50000";
    yield* control.start;
    yield* control.streamStatus.pipe(
      Stream.filter((status) => status.state !== "starting"),
      Stream.runHead,
    );
    assert.deepStrictEqual(
      world.linked.map((entry) => entry.url),
      [url, "http://127.0.0.1:50000"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("a failed link or build shows its reason, and Start tries again", () => {
  const { world, layer } = harness({ linkError: "The peer refused the sign-in." });
  return Effect.gen(function* () {
    const failed = yield* started;
    assert.strictEqual(failed.state, "failed");
    assert.include(failed.error ?? "", "refused the sign-in");
    assert.strictEqual(failed.environmentId, null);
    world.linkError = null;
    assert.strictEqual((yield* started).state, "running");
    world.container = "missing";
    world.ensureError = "Docker could not build the sandbox image.";
    const build = yield* started;
    assert.deepInclude(build, {
      state: "failed",
      error: "Docker could not build the sandbox image.",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("reports the container's own state, and a running one that is not linked", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    assert.strictEqual((yield* control.status).state, "not_created");
    world.container = "stopped";
    assert.strictEqual((yield* control.status).state, "stopped");
    world.container = "docker_unavailable";
    assert.strictEqual((yield* control.status).state, "docker_unavailable");
    world.container = "running";
    world.url = url;
    const unlinked = yield* control.status;
    assert.strictEqual(unlinked.state, "failed");
    assert.include(unlinked.error ?? "", "not linked");
  }).pipe(Effect.provide(layer));
});

it.effect("a container that came back at another address is not reported as linked", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    assert.strictEqual((yield* started).state, "running");
    // Docker restarted the container on another port; nothing linked it again.
    world.url = "http://127.0.0.1:50000";
    const moved = yield* control.status;
    assert.deepInclude(moved, { state: "failed", environmentId: null });
    assert.include(moved.error ?? "", "current address");
  }).pipe(Effect.provide(layer));
});

it.effect("stop keeps the link; remove with files forgets it, without files keeps it", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    const directory = yield* Directory.AssistantDirectory;
    yield* started;
    assert.strictEqual((yield* control.stop).state, "stopped");
    assert.strictEqual((yield* control.remove({ deleteVolumes: false })).state, "not_created");
    assert.deepStrictEqual(world.unlinked, []);
    assert.isTrue(Option.isSome(yield* directory.sandboxEnvironmentId));
    yield* control.remove({ deleteVolumes: true });
    assert.deepStrictEqual(world.unlinked, [sandboxId]);
    assert.deepStrictEqual(world.removed, [false, true]);
    assert.isTrue(Option.isNone(yield* directory.sandboxEnvironmentId));
  }).pipe(Effect.provide(layer));
});

it.effect("pairingUrl needs a running sandbox and points a client at its loopback address", () => {
  const { layer } = harness();
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    assert.include((yield* Effect.flip(control.pairingUrl)).message, "not running");
    yield* started;
    assert.deepStrictEqual(yield* control.pairingUrl, {
      pairingUrl: `${url}/pair#token=PAIRCODE`,
    });
  }).pipe(Effect.provide(layer));
});

const configured = Effect.gen(function* () {
  const control = yield* Control.AssistantSandboxControl;
  return { control, sql: yield* SqlClient.SqlClient };
});

it.effect("configure stores the CPU limit, applies it to the container and shows it", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    assert.deepInclude(yield* control.status, { cpus: null, whenDone: "discard" });
    assert.isFalse((yield* control.config).chosen);
    // No container yet: nothing to update, but the choice is kept for the first start.
    yield* control.configure({ cpus: 4 });
    assert.deepStrictEqual(world.limits, [4]);
    assert.deepInclude(yield* control.config, { cpus: 4, chosen: true });
    yield* started;
    assert.deepStrictEqual(world.ensured, [4]);
    const kept = yield* control.configure({ whenDone: "keep" });
    assert.deepInclude(kept, { cpus: 4, whenDone: "keep" });
    assert.deepStrictEqual(world.limits, [4]);
    assert.deepInclude(yield* control.configure({ cpus: null }), { cpus: null });
    assert.deepStrictEqual(world.limits, [4, null]);
  }).pipe(Effect.provide(layer));
});

const forTask = (taskId: string) =>
  Effect.gen(function* () {
    const { control } = yield* configured;
    const status = yield* control.startForTask;
    yield* control.taskStarted(sandboxId, taskId);
    return status;
  });

it.effect("a container started for a task is discarded when its last task ends", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    assert.deepInclude(yield* forTask("t1"), { state: "running", environmentId: sandboxId });
    yield* control.taskStarted(sandboxId, "t2");
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
    yield* control.taskEnded("t2");
    // Files and sign-ins stay: only the container goes.
    assert.deepStrictEqual(world.removed, [false]);
    assert.isFalse((yield* control.config).oneOff);
    assert.strictEqual((yield* control.status).state, "not_created");
  }).pipe(Effect.provide(layer));
});

it.effect("a container that was already running is never discarded", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    yield* started;
    yield* forTask("t1");
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a container is kept when the setting says keep", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    yield* control.configure({ whenDone: "keep" });
    yield* forTask("t1");
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
  }).pipe(Effect.provide(layer));
});

it.effect("the user's Start takes a task's container over, and tasks never discard it", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    yield* forTask("t1");
    yield* control.start;
    assert.isFalse((yield* control.config).oneOff);
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
  }).pipe(Effect.provide(layer));
});

it.effect("a task that is not tracked, or sandboxed assistants, keep the container", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control, sql } = yield* configured;
    yield* forTask("t1");
    // Another environment's task, and one that was never recorded, change nothing.
    yield* control.taskStarted(EnvironmentId.make("elsewhere"), "t9");
    yield* control.taskEnded("t9");
    assert.deepStrictEqual(world.removed, []);
    yield* sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, workspace, created_at, updated_at)
      VALUES ('a1', 'box', 'Box', 'p1', 'full', 'sandbox', 'now', 'now')`;
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
  }).pipe(Effect.provide(layer));
});

it.effect("discard removes the container but not while a task still runs in it", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    yield* forTask("t1");
    assert.include((yield* Effect.flip(control.discard)).message, "1 task is still running");
    assert.deepStrictEqual(world.removed, []);
    assert.isTrue(yield* control.isSandbox(sandboxId));
    assert.isFalse(yield* control.isSandbox(EnvironmentId.make("elsewhere")));
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, [false]);
    // Nothing left to discard is not an error.
    assert.strictEqual((yield* control.discard).state, "not_created");
  }).pipe(Effect.provide(layer));
});

it.effect("discard is refused while an assistant works in the container", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control, sql } = yield* configured;
    yield* forTask("t1");
    yield* control.taskEnded("t1");
    yield* forTask("t2");
    yield* control.taskEnded("t2");
    yield* sql`
      INSERT INTO assistants (assistant_id, handle, name, project_id, tool_access, workspace, created_at, updated_at)
      VALUES ('a1', 'box', 'Box', 'p1', 'full', 'sandbox', 'now', 'now')`;
    yield* forTask("t3");
    yield* control.taskEnded("t3");
    assert.include((yield* Effect.flip(control.discard)).message, "1 assistant works");
    assert.strictEqual(world.removed.length, 2);
  }).pipe(Effect.provide(layer));
});
