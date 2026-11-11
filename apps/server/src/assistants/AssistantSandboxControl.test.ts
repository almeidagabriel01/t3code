import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  PeerLinkError,
  type PeerLink,
  type PeerLinkCreateInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
  /** What `ensure` waits on first, standing for an image build. */
  hold: Effect.Effect<void>;
  github: string | null;
  /** How `gh auth login` ends after it showed its code. */
  githubLogin: Effect.Effect<string, AssistantSandbox.AssistantSandboxError>;
  githubAccountReads: number;
  /** What `setCpus` waits on after `docker update` ran, standing for a slow reply on a loaded machine. */
  afterCpus: Effect.Effect<void>;
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
    hold: Effect.void,
    github: null,
    githubLogin: Effect.succeed("octo"),
    githubAccountReads: 0,
    afterCpus: Effect.void,
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
      Effect.suspend(() => world.hold).pipe(
        Effect.andThen(
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
        ),
      ),
    setCpus: (cpus) =>
      Effect.sync(() => void world.limits.push(cpus)).pipe(
        Effect.andThen(Effect.suspend(() => world.afterCpus)),
      ),
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
    githubAccount: Effect.sync(() => {
      world.githubAccountReads += 1;
      return world.github;
    }),
    githubLogin: (prompt) =>
      Deferred.succeed(prompt, {
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
      }).pipe(
        Effect.andThen(Effect.suspend(() => world.githubLogin)),
        Effect.tap((login) => Effect.sync(() => void (world.github = login))),
      ),
    githubLogout: Effect.sync(() => void (world.github = null)),
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
            // Like PeerLinks: an address alone never moves a live link to another address.
            const current = world.links.get(sandboxId);
            if (
              current !== undefined &&
              DateTime.isGreaterThan(current.expiresAt, yield* DateTime.now) &&
              !current.urls.includes(input.url)
            ) {
              return yield* new PeerLinkError({
                reason: "pairing_rejected",
                message: "Already linked at another address.",
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
    assert.deepStrictEqual(world.unlinked, [sandboxId]);
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

it.effect("a CPU limit the caller stops waiting for is still stored with the container's", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    const applied = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    world.afterCpus = Deferred.succeed(applied, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const call = yield* control.configure({ cpus: 2 }).pipe(Effect.forkChild);
    yield* Deferred.await(applied);
    // The client disconnects while the container already has the new limit.
    const leaving = yield* Fiber.interrupt(call).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(leaving);
    assert.deepStrictEqual(world.limits, [2]);
    assert.deepInclude(yield* control.config, { cpus: 2, chosen: true });
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

it.effect("a task waits a while for a first build, then is told to ask again", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    const built = yield* Deferred.make<void>();
    world.hold = Deferred.await(built);
    const first = yield* control.startForTask.pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("90 seconds");
    assert.strictEqual((yield* Fiber.join(first)).state, "starting");
    // A second task during the build joins it, and the build stays one started for tasks.
    const second = yield* control.startForTask.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(built, undefined);
    assert.deepInclude(yield* Fiber.join(second), { state: "running", environmentId: sandboxId });
    assert.deepStrictEqual(world.ensured, [null]);
    assert.isTrue((yield* control.config).oneOff);
  }).pipe(Effect.provide(layer));
});

it.effect("discard and remove are refused while the container is starting", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    const built = yield* Deferred.make<void>();
    world.hold = Deferred.await(built);
    assert.strictEqual((yield* control.start).state, "starting");
    assert.include((yield* Effect.flip(control.discard)).message, "is starting");
    assert.include(
      (yield* Effect.flip(control.remove({ deleteVolumes: true }))).message,
      "is starting",
    );
    assert.deepStrictEqual(world.removed, []);
    yield* Deferred.succeed(built, undefined);
  }).pipe(Effect.provide(layer));
});

it.effect("a task on its way into the container keeps it from being discarded", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control } = yield* configured;
    yield* forTask("t1");
    const recorded = yield* Deferred.make<void>();
    const sending = yield* control
      .holding(Deferred.await(recorded))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* control.taskEnded("t1");
    assert.deepStrictEqual(world.removed, []);
    assert.include((yield* Effect.flip(control.discard)).message, "on its way");
    yield* Deferred.succeed(recorded, undefined);
    yield* Fiber.join(sending);
    assert.strictEqual((yield* control.discard).state, "not_created");
  }).pipe(Effect.provide(layer));
});

it.effect("a task that already has its result never keeps the container", () => {
  const { world, layer } = harness();
  return Effect.gen(function* () {
    const { control, sql } = yield* configured;
    yield* forTask("t1");
    // Its end was recorded here, but the server stopped before the sandbox heard of it.
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('t1', 'thread-1', 'node-1', 'remote', 'app_owned', 'completed', 'now',
        '{"result":"Done."}')`;
    assert.strictEqual((yield* control.discard).state, "not_created");
    assert.deepStrictEqual(world.removed, [false]);
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

const githubOf = (control: Control.AssistantSandboxControl["Service"]) =>
  control.status.pipe(Effect.map((status) => status.github));

const githubSettles = (control: Control.AssistantSandboxControl["Service"]) =>
  control.streamStatus.pipe(
    Stream.map((status) => status.github),
    Stream.filter((github) => github.state !== "signing_in"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect("GitHub sign-in shows the code to enter, then the account it signed in to", () => {
  const { world, layer } = harness({ githubLogin: Effect.never });
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    assert.strictEqual((yield* githubOf(control)).state, "unavailable");
    assert.include((yield* Effect.flip(control.githubSignIn)).message, "Start the sandbox");
    yield* started;
    assert.deepInclude(yield* githubOf(control), { state: "signed_out", login: null });
    const signing = yield* control.githubSignIn;
    assert.deepInclude(signing.github, {
      state: "signing_in",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    // A second press while the code is up shows the same code.
    assert.deepStrictEqual((yield* control.githubSignIn).github, signing.github);
    // Cancel stops the login waiting in the container.
    assert.deepInclude((yield* control.githubSignOut).github, { state: "signed_out" });
    world.githubLogin = Effect.succeed("octo");
    yield* control.githubSignIn;
    assert.deepInclude(yield* githubSettles(control), { state: "signed_in", login: "octo" });
    assert.strictEqual((yield* control.githubSignIn).github.state, "signed_in");
    assert.deepInclude((yield* control.githubSignOut).github, { state: "signed_out" });
    assert.isNull(world.github);
  }).pipe(Effect.provide(layer));
});

it.effect("a GitHub sign-in that fails says why and can be tried again", () => {
  const { world, layer } = harness({
    githubLogin: Effect.fail(
      new AssistantSandbox.AssistantSandboxError({
        reason: "docker_failed",
        message: "The code expired before it was entered. Sign in again.",
      }),
    ),
  });
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    yield* started;
    yield* control.githubSignIn;
    assert.deepInclude(yield* githubSettles(control), {
      state: "signed_out",
      error: "The code expired before it was entered. Sign in again.",
    });
    world.githubLogin = Effect.succeed("octo");
    yield* control.githubSignIn;
    assert.deepInclude(yield* githubSettles(control), { state: "signed_in", error: null });
  }).pipe(Effect.provide(layer));
});

it.effect("the GitHub account is read once per container and again after a remove", () => {
  const { world, layer } = harness({ github: "octo" });
  return Effect.gen(function* () {
    const control = yield* Control.AssistantSandboxControl;
    yield* started;
    assert.deepInclude(yield* githubOf(control), { state: "signed_in", login: "octo" });
    yield* githubOf(control);
    assert.strictEqual(world.githubAccountReads, 1);
    yield* control.remove({ deleteVolumes: false });
    assert.strictEqual((yield* githubOf(control)).state, "unavailable");
    assert.include((yield* Effect.flip(control.githubSignOut)).message, "Start the sandbox");
    yield* started;
    yield* githubOf(control);
    assert.strictEqual(world.githubAccountReads, 2);
  }).pipe(Effect.provide(layer));
});
