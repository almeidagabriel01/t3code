import * as M from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- Test harness calls only toolkits registered through McpHttpServer.toolkitRegistration.
import { McpSchema, McpServer } from "effect/ai";
import { ensureMemorySchema } from "../../../persistence/MemorySchema.ts";
import * as RepositoryResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import * as Quota from "../../../memory/MemoryQuotaService.ts";
import * as Service from "../../../memory/MemoryService.ts";
import * as Sync from "../../../memory/MemorySyncService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(id(1));
export const memoryId = M.MemoryId.make(id(2));
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(M.EnvironmentId.make("fixture-memory-mcp")),
});
const database = Layer.effectDiscard(ensureMemorySchema()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const makeCore = <E, R>(
  serviceLayer: typeof Service.layer,
  databaseLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
  environmentLayer = identity,
) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(
      Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(databaseLayer)))),
    ),
    Layer.provide(environmentLayer),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  );
export const core = makeCore(Service.layer, database);
const sync = Layer.mock(Sync.MemorySyncService)({
  syncStatus: (_input, permit) =>
    permit.pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "hub_disabled" })))),
});

const makeLayer = <E, R>(serviceCore: Layer.Layer<Layer.Success<typeof core>, E, R>) =>
  McpHttpServer.layerMemoryToolkit.pipe(
    Layer.provideMerge(serviceCore),
    Layer.provide(sync),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provide(NodeServices.layer),
  );
export const layer = makeLayer(core);

export const layerWithSourceReadAuthority = (
  authority: Service.MemorySourceReadAuthority["readSource"],
) => makeLayer(makeCore(Service.layerWithSourceReadAuthority(authority), database));
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "memory-test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "memory-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
export const scope = (
  scopes: ReadonlyArray<M.AuthEnvironmentScope> = ["memory:read", "memory:write"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: M.EnvironmentId.make("fixture-memory-mcp"),
  requestNamespace: "fixture",
  thread: undefined,
  client: { sessionId: "fixture-client", label: "Synthetic", access: "auto" },
  capabilities: new Set(["memory"]),
  grantedScopes: scopes,
  reauthorize: (required) =>
    required.every((scope) => scopes.includes(scope))
      ? Effect.void
      : Effect.fail(
          new M.EnvironmentAuthorizationError({
            message: "Scope denied.",
            requiredScope: required[0] ?? "memory:read",
          }),
        ),
  issuedAt: 0,
});
export const upsert = (n = 3): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
  baseBoundary: null,
});
const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
export const call = (name: string, input: object, invocation = scope()) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name, arguments: input });
    const body = yield* json(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
    return { result, body };
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
