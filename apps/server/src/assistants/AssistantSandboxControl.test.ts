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
    ...initial,
  };
  const status = () =>
    ({
      state: world.container,
      url: world.container === "running" ? world.url : null,
    }) satisfies AssistantSandbox.AssistantSandboxStatus;
  const sandbox = Layer.succeed(AssistantSandbox.AssistantSandbox, {
    status: Effect.sync(status),
    ensure: Effect.suspend(() => {
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
