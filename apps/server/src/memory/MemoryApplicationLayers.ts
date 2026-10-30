// @effect-diagnostics effectFnOpportunity:off -- hot memory path helpers; Effect.fn would add a span to every call.
// @effect-diagnostics nodeBuiltinImport:off - the closed import factory requires a synchronous UUID callback.
import { MEMORY_PROTOCOL_VERSION, MemoryHubError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpRouter } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import { parseClaudeMemory } from "./imports/ClaudeMemoryImporter.ts";
import { parseCodexMemory } from "./imports/CodexMemoryImporter.ts";
import {
  acquireMemoryImportReader,
  preflightMemoryImportStateDirectory,
  type MemoryImportReaderConfig,
} from "./imports/MemoryImportReader.ts";
import { ProviderMemoryImportRuntime } from "./imports/MemoryImportTypes.ts";
import { makeProviderMemoryImport } from "./imports/ProviderMemoryImport.ts";
import * as MemoryMaintenance from "./MemoryFtsMaintenance.ts";
import * as MemoryGenerationHold from "./MemoryGenerationHold.ts";
import { MemoryHubHttpReady } from "./MemoryHubHttp.ts";
import * as MemoryHub from "./MemoryHubService.ts";
import * as MemoryHubLayers from "./MemoryHubLayers.ts";
import * as MemoryQuota from "./MemoryQuotaService.ts";
import * as MemoryService from "./MemoryService.ts";
import * as MemorySnapshot from "./MemorySnapshot.ts";
import * as MemoryStore from "./MemoryStore.ts";
import * as MemorySync from "./MemorySyncService.ts";
import * as MemoryWorker from "./MemoryWorker.ts";

// Sync needs the core service at construction; source reads need Sync only at invocation.
// The application owns this single binding so neither service constructs a second core.
class MemorySourceReadBinding extends Context.Service<
  MemorySourceReadBinding,
  {
    readonly readSource: MemoryService.MemorySourceReadAuthority["readSource"];
    readonly importSync: Pick<
      MemorySync.MemorySyncService["Service"],
      "readLocalReadiness" | "requireBootstrap" | "syncStatus"
    >;
    readonly bind: (sync: MemorySync.MemorySyncService["Service"]) => Effect.Effect<void>;
  }
>()("t3/memory/MemoryApplicationLayers/MemorySourceReadBinding") {}

/**
 * The memory application: core store, worker, imports, snapshot and the hub seam. server.ts calls
 * this once and passes its own persistence, settings and text generation layers, so every memory
 * service shares those instances and each memory layer below exists once.
 */
export const makeMemoryApplicationLayers = <PS, PE, PR, IS, IE, IR, SS, SE, SR, TS, TE, TR>(deps: {
  readonly layerPersistence: Layer.Layer<PS, PE, PR>;
  readonly layerRepositoryIdentityResolver: Layer.Layer<IS, IE, IR>;
  readonly layerServerSettings: Layer.Layer<SS, SE, SR>;
  readonly layerTextGeneration: Layer.Layer<TS, TE, TR>;
}) => {
  const {
    layerPersistence,
    layerRepositoryIdentityResolver,
    layerServerSettings,
    layerTextGeneration,
  } = deps;

  const layerMemorySourceReadBinding = Layer.effect(
    MemorySourceReadBinding,
    Effect.gen(function* () {
      const current = yield* Ref.make<MemorySync.MemorySyncService["Service"] | null>(null);
      const bound = <A, E, R>(
        use: (sync: MemorySync.MemorySyncService["Service"]) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | MemoryHubError, R> =>
        Effect.flatMap(Ref.get(current), (sync): Effect.Effect<A, E | MemoryHubError, R> =>
          sync === null
            ? Effect.fail(new MemoryHubError({ code: "route_unavailable" }))
            : use(sync),
        );
      return MemorySourceReadBinding.of({
        readSource: (input, permit) => bound((sync) => sync.readSource(input, permit)),
        importSync: {
          readLocalReadiness: () => bound((sync) => sync.readLocalReadiness()),
          requireBootstrap: (space) => bound((sync) => sync.requireBootstrap(space)),
          syncStatus: (input, permit) => bound((sync) => sync.syncStatus(input, permit)),
        },
        bind: (sync) => Ref.set(current, sync),
      });
    }),
  );
  // Hub seam: MemoryHubLayers starts sync after handing it to this binder.
  const layerMemorySyncBinder = Layer.effect(
    MemoryHubLayers.MemorySyncBinder,
    MemorySourceReadBinding.use((binding) =>
      Effect.succeed(MemoryHubLayers.MemorySyncBinder.of({ bind: binding.bind })),
    ),
  ).pipe(Layer.provide(layerMemorySourceReadBinding));

  // One layer reference for the worker and layerMemorySync, so the worker, conflict resolution and
  // the status read share one set of holds. The registry supplies the provider version in each key.
  const layerMemoryGenerationHold = MemoryGenerationHold.layer.pipe(
    Layer.provide(ProviderRegistry.layer),
  );
  const layerMemoryQuota = MemoryQuota.layer.pipe(Layer.provideMerge(MemoryStore.layer));
  const layerMemorySourceReadService = Layer.unwrap(
    MemorySourceReadBinding.use((binding) =>
      Effect.succeed(MemoryService.layerWithSourceReadAuthority(binding.readSource)),
    ),
  ).pipe(Layer.provide(layerMemorySourceReadBinding));
  const layerMemoryService = layerMemorySourceReadService.pipe(
    Layer.provide(layerServerSettings),
    Layer.provideMerge(layerMemoryQuota),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerRepositoryIdentityResolver),
    Layer.provide(layerPersistence),
  );
  const layerMemoryWorker = MemoryWorker.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provideMerge(layerMemoryService),
    Layer.provide(MemoryMaintenance.layer.pipe(Layer.provide(layerMemoryQuota))),
    Layer.provide(RuntimeLayer.layerEventSink),
    Layer.provide(layerTextGeneration),
    Layer.provide(RuntimeIdentity.layer),
    Layer.provide(layerMemoryGenerationHold),
  );
  const layerMemoryStarted = Layer.effectDiscard(
    MemoryWorker.MemoryWorker.use((worker) => worker.start()),
  ).pipe(Layer.provideMerge(layerMemoryWorker));

  // HUB SEAM: hub services and routes, then sync. Everything above is hub-independent.
  const layerMemoryHub = MemoryHubLayers.layerMemoryHub.pipe(
    Layer.provideMerge(layerMemoryService),
    Layer.provideMerge(layerServerSettings),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(ServerSecretStore.layer),
  );
  // Routes only: providing, not merging, keeps hub services out of the HTTP layer's outputs.
  const layerRegisteredMemoryHub = MemoryHubLayers.layerMemoryHubRoutes.pipe(
    HttpRouter.provideRequest(layerMemoryHub),
    Layer.provide(layerMemoryHub),
  );
  // Published to the environment descriptor. The routes themselves mount in the HTTP layer, where
  // HttpRouter exists; server.ts merges layerRegisteredMemoryHub there.
  const layerMemoryHubReady = Layer.succeed(
    MemoryHubHttpReady,
    MemoryHubHttpReady.of({ protocolVersion: MEMORY_PROTOCOL_VERSION }),
  );
  // Sync and the ws handlers look the administrator up in their call context, so the application
  // exposes it; narrowed so the hub's other services and its settings stay private.
  const layerMemoryHubAdministrator: Layer.Layer<
    MemoryHub.MemoryHubAdministrator,
    Layer.Error<typeof layerMemoryHub>,
    Layer.Services<typeof layerMemoryHub>
  > = Layer.effect(
    MemoryHub.MemoryHubAdministrator,
    MemoryHub.MemoryHubAdministrator.use((administrator) => Effect.succeed(administrator)),
  ).pipe(Layer.provide(layerMemoryHub));
  const layerMemorySync = MemoryHubLayers.layerMemorySync.pipe(
    Layer.provide(layerMemorySyncBinder),
    Layer.provide(layerMemoryHub),
    Layer.provide(layerTextGeneration),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerMemoryGenerationHold),
  );

  /** Acquisition is isolated from the core graph; only a fully acquired reader publishes the tag. */
  const layerMemoryImport = (config?: MemoryImportReaderConfig) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const service = yield* MemoryService.MemoryService;
        const { importSync: sync } = yield* MemorySourceReadBinding;
        const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
        const environmentId = yield* identity.getEnvironmentId;
        const server = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const home = yield* HostProcess.HomeDirectory;
        const readerConfig = config ?? {
          stateDir: server.stateDir,
          roots: [
            { format: "codex", rootSlot: "default", path: path.join(home, ".codex") },
            { format: "claude", rootSlot: "default", path: path.join(home, ".claude", "projects") },
          ],
        };
        const reader = yield* preflightMemoryImportStateDirectory(readerConfig.stateDir).pipe(
          Effect.andThen(acquireMemoryImportReader(readerConfig)),
          Effect.result,
        );
        if (reader._tag === "Failure") {
          yield* Effect.logWarning("Provider memory import unavailable", {
            issue: reader.failure.issue,
            ...(reader.failure.issue === "path_rejected"
              ? {
                  stateDir: readerConfig.stateDir,
                  recovery:
                    "Match the stateDir owner to the server execution UID. If shared writes are not needed, remove group/other write permission and restart. If shared writes are needed, use a dedicated stateDir.",
                }
              : {}),
          });
          return Layer.empty;
        }
        yield* Effect.logInfo("Provider memory import available", {
          stateDir: readerConfig.stateDir,
        });
        return Layer.succeed(
          ProviderMemoryImportRuntime,
          makeProviderMemoryImport(
            {
              ...service.importPorts,
              readiness: sync.readLocalReadiness,
              requireBootstrap: sync.requireBootstrap,
              syncStatus: sync.syncStatus,
            },
            reader.success,
            { codex: parseCodexMemory, claude: parseClaudeMemory },
            {
              uuid: () => NodeCrypto.randomUUID(),
              now: () => Clock.currentTimeMillis,
              environmentId,
            },
          ),
        );
      }),
    );
  const layerProviderMemoryImport = layerMemoryImport().pipe(
    Layer.provide(layerMemoryService),
    Layer.provide(layerMemorySourceReadBinding),
    Layer.provide(ServerEnvironment.layerIdentity),
  );

  const layerMemorySnapshot = MemorySnapshot.layer.pipe(
    Layer.provide(layerMemorySync),
    Layer.provide(layerMemoryService),
    Layer.provide(layerMemoryQuota),
    Layer.provide(ProjectionStoreV2.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerPersistence),
  );

  // The descriptor advertises memory import and hub routes from what these layers publish.
  const layerServerEnvironment = ServerEnvironment.layer.pipe(
    Layer.provide(layerProviderMemoryImport),
    Layer.provide(layerMemoryHubReady),
    Layer.provide(layerServerSettings),
    Layer.provide(ServerSecretStore.layer),
  );

  return {
    layerServerEnvironment,
    layerRegisteredMemoryHub,
    layerMemoryHubAdministrator,
    layerMemoryService,
    layerMemoryStarted,
    layerMemoryHubReady,
    layerMemorySync,
    layerProviderMemoryImport,
    layerMemorySnapshot,
  };
};
