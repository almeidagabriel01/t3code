/**
 * Hub routes and sync, installed once from `server.ts`: merge `layerRegisteredMemoryHub` into the
 * route layer and provide `layerMemorySync` beside the memory application. Optional `MemorySyncBinder`
 * receives the sync service before it starts. Open requirements come from the application graph.
 */
import { MemoryHubError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MemoryCompactor from "./MemoryCompactor.ts";
import * as MemoryHubAuth from "./MemoryHubAuth.ts";
import * as MemoryHubHttp from "./MemoryHubHttp.ts";
import * as MemoryHub from "./MemoryHubService.ts";
import * as MemoryOwnerSourceReadPolicyBinding from "./MemoryOwnerSourceReadPolicyBinding.ts";
import * as MemoryStore from "./MemoryStore.ts";
import * as MemorySyncRuntimeLive from "./MemorySyncRuntimeLive.ts";
import * as MemorySync from "./MemorySyncService.ts";

/** Optional hook that receives the sync service before it starts. */
export class MemorySyncBinder extends Context.Service<
  MemorySyncBinder,
  { readonly bind: (sync: MemorySync.MemorySyncService["Service"]) => Effect.Effect<void> }
>()("t3/memory/MemoryHubLayers/MemorySyncBinder") {}

export const layerMemoryHubServices = Layer.mergeAll(
  MemoryHub.layer,
  MemoryHub.administratorLayer,
  MemoryCompactor.layer,
  MemoryHubAuth.layer,
).pipe(
  Layer.provideMerge(MemoryHub.activityLayer),
  Layer.provideMerge(
    Layer.effect(
      MemoryHub.MemoryHubConfiguration,
      Effect.gen(function* () {
        const settings = yield* ServerSettings.MemoryHubCommittedSettings;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const hubEnvironmentId = yield* identity.getEnvironmentId;
        return MemoryHub.MemoryHubConfiguration.of({
          read: settings.read.pipe(
            Effect.map(({ settings: memoryHub }) =>
              memoryHub.mode === "hub" && memoryHub.memorySpaceId !== null
                ? { memorySpaceId: memoryHub.memorySpaceId, hubEnvironmentId }
                : null,
            ),
          ),
        });
      }),
    ),
  ),
);

// The HTTP seam's tag has the service's runtime key; supply the actual instance.
const layerMemoryHubHttpService = Layer.effect(
  MemoryHubHttp.MemoryHubService,
  MemoryHub.MemoryHubService,
);
export const layerMemoryHubRoutes = MemoryHubHttp.layer.pipe(
  HttpRouter.provideRequest(layerMemoryHubHttpService),
  Layer.provide(layerMemoryHubHttpService),
);

/** Starts the compactor once a hub is configured and ready, and again after a later enable. */
export const layerMemoryHubStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const configuration = yield* MemoryHub.MemoryHubConfiguration;
    const store = yield* MemoryStore.MemoryStore;
    const compactor = yield* MemoryCompactor.MemoryCompactor;
    const applicationScope = yield* Scope.Scope;
    // Subscribe before readiness/read to retain a concurrent first enable.
    const changes = yield* settings.subscribeChanges;
    const readyPrincipal = Effect.gen(function* () {
      const hub = yield* configuration.read;
      if (!hub) return Option.none();
      return yield* store.transact(
        Effect.gen(function* () {
          const member = yield* store.readHubMember(hub.memorySpaceId, hub.hubEnvironmentId);
          const retention = yield* store.readHubRetentionTx(hub.memorySpaceId);
          if (!member || member.status !== "active" || retention.checkpointId === null)
            return yield* new MemoryHubError({ code: "bootstrap_required" });
          return Option.some({
            memorySpaceId: hub.memorySpaceId,
            environmentId: hub.hubEnvironmentId,
            credentialVersion: member.credentialVersion,
            scopes: ["memory:sync"] as const,
          });
        }),
      );
    });
    yield* Stream.concat(Stream.succeed(undefined), changes).pipe(
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          const principal = yield* readyPrincipal;
          if (Option.isNone(principal)) return false;
          const startScope = yield* Scope.fork(applicationScope);
          yield* compactor.start(principal.value).pipe(
            Effect.provideService(Scope.Scope, startScope),
            // A failed sweep releases its subscriptions; a successful start keeps the scope.
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(startScope, exit) : Effect.void,
            ),
          );
          return true;
        }).pipe(
          // Readiness and the initial sweep can race with disable; retry on the next transition.
          Effect.catch((error) =>
            Effect.logWarning("Memory compactor startup deferred", { errorTag: error._tag }).pipe(
              Effect.as(false),
            ),
          ),
        ),
      ),
      Stream.filter((started) => started),
      Stream.take(1),
      Stream.runDrain,
      // Startup marks settings ready after building its dependencies; await it in a scoped fiber.
      (run) => Effect.andThen(settings.ready, run),
      Effect.forkScoped,
    );
  }),
);

export const layerMemoryHub = layerMemoryHubStarted.pipe(
  Layer.provideMerge(layerMemoryHubServices),
);

/**
 * Hub services plus the routes that expose them; merge into the server's route layer.
 * @public
 */
export const layerRegisteredMemoryHub = layerMemoryHubRoutes.pipe(
  HttpRouter.provideRequest(layerMemoryHub),
  Layer.provideMerge(layerMemoryHub),
);

const layerMemoryDefaultStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const sync = yield* MemorySync.MemorySyncService;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* Effect.andThen(settings.ready, sync.initializeDefaultHub).pipe(
      Effect.catch(() =>
        Effect.logWarning("memory initialization unavailable", {
          code: "memory_default_unavailable",
        }),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layerMemorySyncStarted = Layer.merge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* MemorySync.MemorySyncService;
      const binder = yield* Effect.serviceOption(MemorySyncBinder);
      if (Option.isSome(binder)) yield* binder.value.bind(sync);
      yield* sync.start;
    }),
  ),
  layerMemoryDefaultStarted,
).pipe(Layer.provideMerge(MemorySync.layer));

/** Production runtime for sync, including the single committed owner-policy adapter. */
const layerMemorySyncRuntime = MemorySyncRuntimeLive.layer.pipe(
  Layer.provideMerge(MemoryOwnerSourceReadPolicyBinding.layer),
);

/** @public */
export const layerMemorySync = layerMemorySyncStarted.pipe(
  Layer.provideMerge(layerMemorySyncRuntime),
  Layer.provide(layerMemoryHub),
);
