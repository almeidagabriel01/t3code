import * as DocumentText from "../../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ChatImageAttachment,
  CommandId,
  EnvironmentId,
  NodeId,
  OrchestratorMcpThreadReadResult,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  OrchestrationV2ThreadHandoffError,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpAttachmentInput } from "./attachment/input.ts";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../../orchestration-v2/Orchestrator.ts";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadHandoffService from "../../orchestration-v2/ThreadHandoffService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../../peer/RemoteDelegation.ts";
import * as DateTime from "effect/DateTime";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as CheckpointDiffQuery from "../../checkpointing/CheckpointDiffQuery.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../McpToolAccess.testkit.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { dispatchFailure } from "../threadAccess.ts";
import * as EnvironmentHandlers from "./environment/handlers.ts";
import * as AttachmentHandlers from "./attachment/handlers.ts";
import * as PeerForwarding from "../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);

const layerThreadToolkitWith = (
  handoff: Partial<ThreadHandoffService.ThreadHandoffService["Service"]>,
  diffs: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]> = {},
  launch: Partial<ThreadLaunchService.ThreadLaunchService["Service"]> = {},
) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ThreadHandoffService.ThreadHandoffService)(handoff)),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)(diffs)),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)(launch)),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  );
const layerThreadToolkit = layerThreadToolkitWith({});

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-core", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-core", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("checks capability through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.some(({ tool }) => tool.name === "t3_thread_organize")).toBe(true);
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: new Set<never>(),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "capability_denied" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
      ),
    ),
  ),
);

it.effect("an answered question reports already answered instead of not found", () => {
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const requestId = RuntimeRequestId.make("answered-question");
  const projection = McpToolAccessTestkit.idleThreadProjection(shell);
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const respond = (id: string) =>
      server
        .callTool({
          name: "t3_pending_request",
          arguments: { action: "respond", requestId: id, answers: { size: "large" } },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    expect(declaredFailure(yield* respond(requestId))).toMatchObject({
      code: "invalid_request",
      message: "The user-input request was already answered.",
    });
    expect(declaredFailure(yield* respond("missing-question"))).toMatchObject({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () =>
              Effect.succeed({
                ...projection,
                runtimeRequests: [
                  {
                    id: requestId,
                    nodeId: NodeId.make("root"),
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "user_input",
                    status: "resolved",
                    responseCapability: { type: "message" },
                    createdAt: shell.createdAt,
                    resolvedAt: shell.updatedAt,
                    answers: { size: "large" },
                  },
                ],
                turnItems: [
                  {
                    id: TurnItemId.make("answered-question-item"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: null,
                    startedAt: shell.createdAt,
                    completedAt: shell.updatedAt,
                    updatedAt: shell.updatedAt,
                    type: "user_input_request",
                    requestId,
                    questions: [],
                  },
                ],
              }),
            dispatch: () => Effect.die("an answered question must not dispatch again"),
          }),
        ),
      ),
    ),
  );
});

it("bounds public command rejections and redacts internal dispatch causes", () => {
  const command = { commandId: CommandId.make("mcp-core-command"), commandType: "thread.settle" };
  expect(
    dispatchFailure(new OrchestratorDispatchError({ ...command, cause: "🙂".repeat(1001) }))
      .message,
  ).toBe("🙂".repeat(1000));
  expect(
    dispatchFailure(
      new OrchestratorCommandRejectedError({ ...command, cause: "Run is not queued." }),
    ).message,
  ).toBe("Run is not queued.");
  for (const cause of [
    undefined,
    "",
    new Error("private-storage-path"),
    { message: "private-storage-path" },
  ]) {
    expect(dispatchFailure(new OrchestratorDispatchError({ ...command, cause }))).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
    expect(
      dispatchFailure(new OrchestratorCommandRejectedError({ ...command, cause })),
    ).toMatchObject({
      code: "orchestration_error",
      message: "The operation could not be completed.",
    });
  }
  expect(
    dispatchFailure(new OrchestratorProjectionError({ threadId, cause: "private-storage-path" })),
  ).toMatchObject({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });
});

it.effect("returns an HTML render reference that Codex and Claude tool rows both carry", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "html_render",
        arguments: { html: "<p>Revenue</p>", title: "Revenue", height: 240 },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const reference = htmlRenderFromToolItem({
      toolName: "t3-code.html_render",
      output: result.structuredContent,
    });
    expect(reference).toMatchObject({ title: "Revenue", height: 240 });
    expect(
      htmlRenderFromToolItem({ toolName: "mcp__t3-code__html_render", output: result.content }),
    ).toEqual(reference);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerHtmlToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(PreviewBrowser.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-render-" })),
        Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                deletedAt: null,
                archivedAt: null,
                activeRunId: RunId.make("mcp-core-run"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              } as OrchestrationV2ThreadShell),
          }),
        ),
      ),
    ),
  ),
);

it.effect("records only failed calls of tools that hand off no work", () => {
  // Recording runs detached from the tool response, so the first event is awaited.
  const recorded = Deferred.makeUnsafe<{ event: string; properties: object }>();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const organize = (capabilities: McpInvocationContext.McpInvocationScope["capabilities"]) =>
      server.callTool({ name: "t3_thread_organize", arguments: { action: "pin" } }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect((yield* organize(scope.capabilities)).isError).not.toBe(true);
    expect(declaredFailure(yield* organize(new Set<never>()))).toMatchObject({
      code: "capability_denied",
    });
    // The successful call ran first, so it would be the first event if it were recorded.
    expect(yield* Deferred.await(recorded)).toMatchObject({
      event: "mcp.tool.invoked",
      properties: { tool: "t3_thread_organize", outcome: "error" },
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            dispatch: () => Effect.succeed({ sequence: 1 } as never),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              record: (event, properties) =>
                Deferred.succeed(recorded, { event, properties: properties ?? {} }).pipe(
                  Effect.asVoid,
                ),
              flush: Effect.void,
              recordOwners: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
});

it.effect("rejects an unknown organize target instead of archiving the calling thread", () => {
  const dispatched: Array<unknown> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const outcome = yield* server
      .callTool({
        name: "t3_thread_organize",
        arguments: { action: "archive", threadIds: ["other-thread"] },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
        Effect.result,
      );
    expect(dispatched).toEqual([]);
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("Expected no excess property") },
    });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: 1 } as never);
            },
          }),
        ),
      ),
    ),
  );
});

it.effect("keeps unexpected handler defects private through the production registration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_organize", arguments: { action: "pin" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: "Tool execution failed due to an internal server error." },
    ]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.die(new Error("private-storage-path")),
          }),
        ),
      ),
    ),
  ),
);

it("keeps MCP preference output allowlisted and Unicode-bounded", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    privateCredential: "must-not-escape",
    sourceControlWritingStyle: {
      ...DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle,
      customInstructions: "🙂".repeat(4001),
    },
  };
  const result = EnvironmentHandlers.preferences(settings);
  expect(result).not.toHaveProperty("privateCredential");
  expect(result).not.toHaveProperty("providers");
  expect(result.sourceControlWritingStyle).toMatchObject({
    customInstructions: "🙂".repeat(4000),
    truncated: true,
  });
});

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

it.effect("a client caller targets any thread within its ceiling and cannot act as a thread", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const untargeted = yield* call("t3_thread_organize", { action: "pin" }, clientScope("auto"));
    expect(declaredFailure(untargeted)).toMatchObject({ code: "target_required" });

    const pinned = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("auto"),
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.structuredContent).toMatchObject({ sequence: 7 });

    const aboveCeiling = yield* call(
      "t3_thread_organize",
      { action: "pin", threadId: "other-project-thread" },
      clientScope("approval-required"),
    );
    expect(declaredFailure(aboveCeiling)).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });

    const forked = yield* call(
      "t3_thread_transfer",
      { action: "fork", sourcePoint: { type: "latest_stable" } },
      clientScope("auto"),
    );
    expect(declaredFailure(forked)).toMatchObject({ code: "target_required" });
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () => Effect.succeed({ sequence: 7, storedEvents: [] }),
          }),
        ),
      ),
    ),
  ),
);

it.effect("t3_thread_transfer handoff starts the new thread through the handoff service", () => {
  const calls: Array<ThreadHandoffService.ThreadHandoffInput> = [];
  const outcomes = [
    Effect.succeed({ threadId: ThreadId.make("handed-off") }),
    Effect.fail(
      new OrchestrationV2ThreadHandoffError({
        sourceThreadId: ThreadId.make("other-project-thread"),
        reason: "nothing-to-hand-off",
      }),
    ),
  ];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (args: Record<string, unknown>) =>
      server
        .callTool({ name: "t3_thread_transfer", arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const started = yield* call({
      action: "handoff",
      threadId: "other-project-thread",
      context: "full",
    });
    expect(started.structuredContent).toMatchObject({ threadId: "handed-off" });
    expect(calls[0]).toMatchObject({
      sourceThreadId: "other-project-thread",
      mode: "full",
      modelSelection: { model: "source-model" },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const empty = yield* call({ action: "handoff", threadId: "other-project-thread" });
    expect(declaredFailure(empty)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      layerThreadToolkitWith({
        handoff: (input) => {
          calls.push(input);
          return outcomes.shift()!;
        },
      }).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(id, { runtimeMode: "auto" })),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  runtimeMode: "auto",
                  interactionMode: "default",
                  modelSelection: { instanceId: "codex", model: "source-model" },
                  deletedAt: null,
                },
              } as never),
          }),
        ),
      ),
    ),
  );
});

it.effect("a read-only client reads threads and is refused every write before it runs", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            clientScope("read-only"),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const configuration = yield* call("t3_thread_configure", {
      threadId: "other-project-thread",
    });
    expect(configuration.isError).toBe(false);
    expect(configuration.structuredContent).toMatchObject({ runtimeMode: "auto" });

    const pinned = yield* call("t3_thread_organize", {
      action: "pin",
      threadId: "other-project-thread",
    });
    expect(declaredFailure(pinned)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);

    const configure = yield* call("t3_thread_configure", {
      threadId: "other-project-thread",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
    });
    expect(declaredFailure(configure)).toMatchObject({ code: "capability_denied" });
    expect(dispatched).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                id: ThreadId.make("other-project-thread"),
                projectId: "other-project",
                deletedAt: null,
              } as never),
            getProjectThreadRecords: () =>
              Effect.succeed({
                thread: {
                  id: ThreadId.make("other-project-thread"),
                  projectId: "other-project",
                  modelSelection: { instanceId: "codex", model: "gpt-5" },
                  runtimeMode: "auto",
                  interactionMode: "default",
                  deletedAt: null,
                },
              } as never),
            dispatch: () =>
              Effect.sync(() => {
                dispatched.push("dispatch");
                return { sequence: 7 } as never;
              }),
          }),
        ),
      ),
    ),
  ),
);
const dispatched: Array<string> = [];

it.effect("refuses act-as-caller tools to a client caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "delegate_task",
        arguments: { task: "Review", mode: "async" },
      })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          clientScope("full-access"),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code: "thread_credential_required" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  ),
);

it.effect("a caller cannot rewrite a scheduled task that runs above its own modes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const update = yield* call("schedule_task", {
      scheduledTaskId: "task-full-access",
      prompt: "Run something else",
    });
    expect(declaredFailure(update)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const remove = yield* call("delete_scheduled_task", { scheduledTaskId: "task-full-access" });
    expect(declaredFailure(remove)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    const allowed = yield* call("schedule_task", {
      scheduledTaskId: "task-auto",
      enabled: false,
    });
    expect(allowed.isError).toBe(false);
    const incomplete = yield* call("schedule_task", { prompt: "Run nightly" });
    expect(declaredFailure(incomplete)).toMatchObject({ code: "invalid_request" });
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () =>
              Effect.succeed({
                tasks: [
                  scheduledTask("task-full-access", "full-access"),
                  scheduledTask("task-auto", "auto"),
                ],
              }),
            upsert: (input) =>
              Effect.succeed({
                task: { ...(scheduledTask(input.id ?? "task-auto", "auto") as object), ...input },
              } as never),
          }),
        ),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  ),
);

function scheduledTask(id: string, runtimeMode: "auto" | "full-access"): never {
  return {
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project-a",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode,
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as never;
}

it.effect.each(["t3_thread_interrupt", "t3_workflow_stop"])(
  "a caller cannot use %s on a thread that runs above its own modes",
  (toolName) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: toolName,
          arguments: {
            threadId: "full-access-thread",
            ...(toolName === "t3_workflow_stop" ? { subagentId: "workflow-coordinator" } : {}),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope("auto")),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(declaredFailure(result)).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }).pipe(
      Effect.provide(
        layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  projectId: "project-a",
                  deletedAt: null,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                } as never),
              getProjectThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: ThreadId.make("full-access-thread"),
                    projectId: "project-a",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    deletedAt: null,
                  },
                  runs: [],
                } as never),
              stopWorkflow: () => Effect.die("workflow stop must not dispatch above the ceiling"),
              interruptThread: () => Effect.die("interrupt must not dispatch above the ceiling"),
            }),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
          Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
          Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
          Layer.provide(Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({})),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
          Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
          Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
          Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
          Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        ),
      ),
    ),
);

it.effect("discovers workflow stop targets and requires orchestration capability", () => {
  const threadId = ThreadId.make("workflow-parent");
  const shell = McpToolAccessTestkit.liveThreadShell(threadId);
  const subagentId = NodeId.make("workflow-coordinator");
  const itemId = TurnItemId.make("workflow-coordinator-activity");
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: shell.activeRunId,
      nodeId: subagentId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: "Workflow: checkout review",
      startedAt: shell.createdAt,
      completedAt: null,
      updatedAt: shell.updatedAt,
      type: "subagent",
      subagentId,
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: ThreadId.make("workflow-child"),
      prompt: "Review checkout",
      result: null,
    },
  };
  const stopped: Array<{ readonly threadId: ThreadId; readonly subagentId: string }> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = clientScope("full-access");
    const read = yield* server
      .callTool({ name: "t3_thread_read", arguments: { threadId, view: "activity" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(read.isError).toBe(false);
    const result = yield* decodeThreadReadResult(read.structuredContent);
    expect(result.items[0]?.subagentId).toBe(subagentId);
    const call = (invocation: McpInvocationContext.McpInvocationScope) =>
      server
        .callTool({
          name: "t3_workflow_stop",
          arguments: { threadId, subagentId: result.items[0]?.subagentId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const denied = yield* call({ ...scope, capabilities: new Set(["worktree"]) });
    expect(declaredFailure(denied)).toMatchObject({ code: "capability_denied" });
    expect(stopped).toEqual([]);
    const allowed = yield* call(scope);
    expect(allowed.isError).toBe(false);
    expect(stopped).toEqual([{ threadId: "workflow-parent", subagentId: "workflow-coordinator" }]);
  }).pipe(
    Effect.provide(
      layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: () =>
              Effect.succeed(McpToolAccessTestkit.idleThreadProjection(shell)),
            getTimelinePage: () => Effect.succeed({ items: [row], totalItems: 1, hasMore: false }),
            stopWorkflow: (input) =>
              Effect.sync(() => {
                stopped.push(input);
              }),
          }),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({})),
        Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
        Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
        Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      ),
    ),
  );
});

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (
      name: string,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const prepared = yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );
    const { attachmentId } = prepared.structuredContent as { readonly attachmentId: string };
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("t3_attachment_discard", { attachmentId }, otherThread);
    expect(declaredFailure(refused)).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 } },
      scope,
    );

    const discarded = yield* call(
      "t3_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isError).toBe(false);
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAttachmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ),
  ),
);

it.effect("t3_thread_diff reads one turn or the whole thread, cut at the read budget", () => {
  const calls: Array<readonly [string, unknown]> = [];
  const result = (input: { readonly threadId: ThreadId; readonly toTurnCount: number }) => ({
    threadId: input.threadId,
    fromTurnCount: 0,
    toTurnCount: input.toTurnCount,
    diff: "é".repeat(100_000),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const diff = (args: object, granted: McpInvocationContext.McpInvocationScope["capabilities"]) =>
      server.callTool({ name: "t3_thread_diff", arguments: args }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...scope,
          capabilities: granted,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const whole = (yield* diff({}, scope.capabilities)).structuredContent as {
      readonly diff: string;
      readonly truncated: boolean;
    };
    expect(whole.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(whole))).toBeLessThanOrEqual(64 * 1024);
    yield* diff({ runId: "mcp-core-run-1" }, scope.capabilities);
    expect(calls).toEqual([
      ["full", { threadId, toTurnCount: 2 }],
      ["turn", { threadId, fromTurnCount: 0, toTurnCount: 1 }],
    ]);
    expect(declaredFailure(yield* diff({}, new Set<never>()))).toMatchObject({
      code: "capability_denied",
    });
    expect(calls).toHaveLength(2);
  }).pipe(
    Effect.provide(
      layerThreadToolkitWith(
        {},
        {
          getFullThreadDiff: (input) =>
            Effect.sync(() => {
              calls.push(["full", input]);
              return result(input);
            }),
          getTurnDiff: (input) =>
            Effect.sync(() => {
              calls.push(["turn", input]);
              return result(input);
            }),
        },
      ).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
            getProjectThreadRecords: ({ threadId: id }) =>
              Effect.succeed(
                McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
              ),
            getCheckpointContext: () =>
              Effect.succeed({
                runs: [1, 2].map((ordinal) => ({
                  id: RunId.make(`mcp-core-run-${ordinal}`),
                  status: "completed",
                })),
                checkpoints: [1, 2].map((ordinal) => ({
                  status: "ready",
                  appRunOrdinal: ordinal,
                  runId: RunId.make(`mcp-core-run-${ordinal}`),
                })),
              } as never),
          }),
        ),
      ),
    ),
  );
});

it.effect(
  "t3_thread_organize retry_preparation replays one command per failure or request id",
  () => {
    const commandIds: Array<string> = [];
    const failedRun = {
      id: RunId.make("mcp-core-run-failed"),
      ordinal: 1,
      status: "failed",
      workspacePreparation: { type: "worktree" },
      completedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    };
    let runs: ReadonlyArray<object> = [failedRun];
    let rejection: string | undefined;
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const retry = (args: object = {}) =>
        server
          .callTool({
            name: "t3_thread_organize",
            arguments: { action: "retry_preparation", ...args },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      yield* retry();
      yield* retry();
      expect(commandIds[1]).toBe(commandIds[0]);
      expect(commandIds[0]).toContain(
        `${failedRun.id}:${DateTime.toEpochMillis(failedRun.completedAt)}`,
      );
      yield* retry({ clientRequestId: "a" });
      yield* retry({ clientRequestId: "a" });
      yield* retry({ clientRequestId: "b" });
      expect(commandIds[3]).toBe(commandIds[2]);
      expect(commandIds[4]).not.toBe(commandIds[2]);

      rejection = `Run ${failedRun.id} has no failed workspace preparation to retry.`;
      expect(declaredFailure(yield* retry({ runId: failedRun.id }))).toMatchObject({
        message: expect.stringContaining("no failed workspace preparation"),
      });
      runs = [];
      expect(declaredFailure(yield* retry())).toMatchObject({ code: "run_not_found" });
    }).pipe(
      Effect.provide(
        layerThreadToolkitWith(
          {},
          {},
          {
            retryPreparation: (input) =>
              rejection === undefined
                ? Effect.sync(() => {
                    commandIds.push(input.commandId);
                    return { sequence: 1, storedEvents: [] };
                  })
                : Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: input.commandId,
                      commandType: "prepared-run.retry",
                      cause: rejection,
                    }),
                  ),
          },
        ).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
              getProjectThreadRecords: ({ threadId: id }) =>
                Effect.succeed({
                  ...McpToolAccessTestkit.idleThreadProjection(
                    McpToolAccessTestkit.liveThreadShell(id),
                  ),
                  runs,
                } as never),
            }),
          ),
        ),
      ),
    );
  },
);

const diffRun = (ordinal: number, status = "completed") => ({
  id: RunId.make(`mcp-core-run-${ordinal}`),
  status,
});
const diffCheckpoint = (ordinal: number, status = "ready") => ({
  status,
  appRunOrdinal: ordinal,
  runId: RunId.make(`mcp-core-run-${ordinal}`),
});

/** The diff tool over a thread whose checkpoints and diff service the test chooses. */
const diffHarness = (options: {
  readonly runs?: ReadonlyArray<ReturnType<typeof diffRun>>;
  readonly checkpoints?: ReadonlyArray<ReturnType<typeof diffCheckpoint>>;
  readonly diffText?: string;
  readonly diffFails?: boolean;
  readonly goneThread?: string;
  readonly access?: "read-only";
}) => {
  const calls: Array<readonly [string, unknown]> = [];
  const result = (input: { readonly threadId: ThreadId; readonly toTurnCount: number }) => ({
    threadId: input.threadId,
    fromTurnCount: 0,
    toTurnCount: input.toTurnCount,
    diff: options.diffText ?? "diff",
  });
  const diffService = (name: string) => (input: { threadId: ThreadId; toTurnCount: number }) =>
    options.diffFails === true
      ? Effect.fail({ message: "checkpoint ref missing" } as never)
      : Effect.sync(() => {
          calls.push([name, input]);
          return result(input);
        });
  const layer = layerThreadToolkitWith(
    {},
    { getFullThreadDiff: diffService("full") as never, getTurnDiff: diffService("turn") as never },
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            id === options.goneThread ? null : McpToolAccessTestkit.liveThreadShell(id),
          ),
        getProjectThreadRecords: ({ threadId: id }) =>
          Effect.succeed(
            McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
          ),
        getCheckpointContext: () =>
          Effect.succeed({
            runs: options.runs ?? [diffRun(1), diffRun(2)],
            checkpoints: options.checkpoints ?? [diffCheckpoint(1), diffCheckpoint(2)],
          } as never),
      }),
    ),
  );
  const call = (args: object) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server.callTool({ name: "t3_thread_diff", arguments: args }).pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          options.access === undefined
            ? scope
            : {
                ...scope,
                thread: undefined,
                client: { sessionId: "client", label: "Client", access: options.access },
              },
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    });
  return { calls, layer, call };
};

it.effect.each([
  ["a turn and a run together", { turn: 1, runId: "mcp-core-run-1" }, "invalid_request"],
  ["a turn with no checkpoint", { turn: 9 }, "invalid_request"],
  ["a run with no checkpoint", { runId: "mcp-core-run-9" }, "invalid_request"],
  ["a thread that is gone", { threadId: "gone-thread" }, "thread_not_found"],
] as const)("t3_thread_diff refuses %s and reads no diff", ([, args, code]) => {
  const { calls, layer, call } = diffHarness({ goneThread: "gone-thread" });
  return call(args).pipe(
    Effect.map((result) => {
      expect(declaredFailure(result)).toMatchObject({ code });
      expect(calls).toEqual([]);
    }),
    Effect.provide(layer),
  );
});

it.effect.each([
  ["a checkpoint that is not ready", { checkpoints: [diffCheckpoint(1, "stale")] }],
  ["a run that did not complete", { runs: [diffRun(1, "failed")] }],
] as const)("t3_thread_diff does not offer a turn or run behind %s", ([, options]) => {
  const { calls, layer, call } = diffHarness(options);
  return Effect.gen(function* () {
    for (const args of [{ turn: 1 }, { runId: "mcp-core-run-1" }]) {
      expect(declaredFailure(yield* call(args))).toMatchObject({ code: "invalid_request" });
    }
    // The whole-thread read counts only what is ready, so it reads nothing rather than guessing.
    yield* call({});
    expect(calls).toEqual([["full", { threadId, toTurnCount: 0 }]]);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "t3_thread_diff reports a diff failure as an orchestration error and forwards its options",
  () => {
    const ok = diffHarness({});
    const failing = diffHarness({ diffFails: true });
    return Effect.gen(function* () {
      yield* Effect.provide(ok.call({ turn: 2, ignoreWhitespace: true }), ok.layer);
      expect(ok.calls).toEqual([
        ["turn", { threadId, fromTurnCount: 1, toTurnCount: 2, ignoreWhitespace: true }],
      ]);
      const failure = declaredFailure(yield* Effect.provide(failing.call({}), failing.layer));
      expect(failure).toMatchObject({ code: "orchestration_error" });
      expect(failure.message).toContain("checkpoint ref missing");
    });
  },
);

it.effect("t3_thread_diff lets a read-only client read a thread's diff", () => {
  const { layer, call } = diffHarness({ access: "read-only" });
  return call({ threadId: "other-thread" }).pipe(
    Effect.map((result) => expect(result.structuredContent).toMatchObject({ diff: "diff" })),
    Effect.provide(layer),
  );
});

it.effect.each([
  { name: "exactly at the budget", slack: 0, truncated: false },
  { name: "one byte under", slack: -1, truncated: false },
  { name: "one byte over", slack: 1, truncated: true },
])("t3_thread_diff keeps a diff $name whole or cut, never past 64 KiB", ({ slack, truncated }) => {
  const shell = { threadId, fromTurnCount: 0, toTurnCount: 2, diff: "", truncated: false };
  const room = 64 * 1024 - Buffer.byteLength(JSON.stringify(shell));
  const { layer, call } = diffHarness({ diffText: "a".repeat(room + slack) });
  return call({}).pipe(
    Effect.map((result) => {
      const body = result.structuredContent as { diff: string; truncated: boolean };
      expect(body.truncated).toBe(truncated);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(64 * 1024);
      if (!truncated) expect(body.diff).toHaveLength(room + slack);
    }),
    Effect.provide(layer),
  );
});

it.effect.each([
  { name: "a multi-byte character", unit: "é", tail: "é" },
  { name: "an emoji", unit: "😀", tail: "😀" },
  { name: "escaped newlines", unit: "\n", tail: "\n" },
])("t3_thread_diff never splits $name at the cut", ({ unit, tail }) => {
  const shell = { threadId, fromTurnCount: 0, toTurnCount: 2, diff: "", truncated: false };
  const room = 64 * 1024 - Buffer.byteLength(JSON.stringify(shell));
  // The last character straddles the budget, so it must be dropped whole.
  const { layer, call } = diffHarness({ diffText: "a".repeat(room - 1) + tail + unit });
  return call({}).pipe(
    Effect.map((result) => {
      const body = result.structuredContent as { diff: string; truncated: boolean };
      expect(body.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(64 * 1024);
      expect(body.diff).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(body.diff.startsWith("a".repeat(room - 1))).toBe(true);
    }),
    Effect.provide(layer),
  );
});

const prepRun = (
  id: string,
  ordinal: number,
  preparation = true,
  completedAt: string | null = "2026-01-01T00:00:00.000Z",
) => ({
  id: RunId.make(id),
  ordinal,
  status: "failed",
  ...(preparation ? { workspacePreparation: { type: "worktree" } } : {}),
  completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
});

/** retry_preparation over runs the test chooses; `launches` records each command id. */
const retryHarness = (options: {
  readonly runs?: ReadonlyArray<object>;
  readonly callerShell?: { readonly activeRunId: null };
  readonly goneThread?: string;
}) => {
  const launches: Array<{ commandId: string; runId: string; threadId: string }> = [];
  const layer = layerThreadToolkitWith(
    {},
    {},
    {
      retryPreparation: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return { sequence: 1, storedEvents: [] };
        }),
    },
  ).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            id === options.goneThread
              ? null
              : McpToolAccessTestkit.liveThreadShell(id, options.callerShell),
          ),
        getProjectThreadRecords: ({ threadId: id }) =>
          Effect.succeed({
            ...McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
            runs: options.runs ?? [prepRun("run-a", 1)],
          } as never),
      }),
    ),
  );
  const call = (args: object, as: McpInvocationContext.McpInvocationScope = scope) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({
          name: "t3_thread_organize",
          arguments: { action: "retry_preparation", ...args },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, as),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  return { launches, layer, call };
};

it.effect(
  "retry_preparation retries the latest prepared run, or the one named, and refuses a missing one",
  () => {
    const { launches, layer, call } = retryHarness({
      runs: [prepRun("run-1", 1), prepRun("run-2", 2, false), prepRun("run-3", 3)],
    });
    return Effect.gen(function* () {
      yield* call({});
      yield* call({ runId: "run-1" });
      expect(launches.map((launch) => launch.runId)).toEqual(["run-3", "run-1"]);
      expect(launches.every((launch) => launch.threadId === threadId)).toBe(true);
      expect(declaredFailure(yield* call({ runId: "run-9" }))).toMatchObject({
        code: "run_not_found",
      });
      expect(launches).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("retry_preparation finds no run when none ever prepared a workspace", () => {
  const { launches, layer, call } = retryHarness({ runs: [prepRun("run-1", 1, false)] });
  return call({}).pipe(
    Effect.map((result) => {
      expect(declaredFailure(result)).toMatchObject({ code: "run_not_found" });
      expect(launches).toEqual([]);
    }),
    Effect.provide(layer),
  );
});

it.effect(
  "retry_preparation derives its command id from the failure, or from the session and request id",
  () => {
    const { launches, layer, call } = retryHarness({
      runs: [prepRun("run-1", 1, true, null)],
    });
    const other = { ...scope, requestNamespace: "another/session" };
    return Effect.gen(function* () {
      yield* call({});
      yield* call({ clientRequestId: "   " });
      // A run still without a completion time keys on "none", and a blank id counts as absent.
      expect(launches[0]!.commandId).toBe("mcp:retry-preparation:run-1:none");
      expect(launches[1]!.commandId).toBe(launches[0]!.commandId);

      yield* call({ clientRequestId: "a/b c" });
      yield* call({ clientRequestId: "a/b c" }, other);
      expect(launches[2]!.commandId).toBe("mcp:retry-preparation:mcp-core-session:a%2Fb%20c");
      expect(launches[3]!.commandId).toBe("mcp:retry-preparation:another%2Fsession:a%2Fb%20c");
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each([
  [
    "a thread that is gone",
    { goneThread: "gone-thread" },
    { threadId: "gone-thread" },
    scope,
    "thread_not_found",
  ],
  [
    "a calling thread with no active run",
    { callerShell: { activeRunId: null } },
    {},
    scope,
    "parent_not_active",
  ],
  [
    "a read-only client",
    {},
    { threadId: "other-thread" },
    {
      ...scope,
      thread: undefined,
      client: { sessionId: "client", label: "Client", access: "read-only" as const },
    },
    "capability_denied",
  ],
] as const)(
  "retry_preparation refuses %s without retrying anything",
  ([, options, args, as, code]) => {
    const { launches, layer, call } = retryHarness(options);
    return call(args, as).pipe(
      Effect.map((result) => {
        expect(declaredFailure(result)).toMatchObject({ code });
        expect(launches).toEqual([]);
      }),
      Effect.provide(layer),
    );
  },
);

const liveProjectThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
  getProjectThreadRecords: ({ threadId: id }) =>
    Effect.succeed(
      McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(id)),
    ),
});

it.effect.each([
  ["launch-failed", "orchestration_error"],
  ["summary-unavailable", "invalid_request"],
  ["summary-failed", "invalid_request"],
  ["provider-disabled", "invalid_request"],
  ["source-not-found", "invalid_request"],
] as const)("t3_thread_transfer handoff maps a %s failure to %s", ([reason, code]) => {
  const handoffs: Array<ThreadHandoffService.ThreadHandoffInput> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "t3_thread_transfer", arguments: { action: "handoff" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(declaredFailure(result)).toMatchObject({ code });
    expect(handoffs).toHaveLength(1);
  }).pipe(
    Effect.provide(
      layerThreadToolkitWith({
        handoff: (input) => {
          handoffs.push(input);
          return Effect.fail(
            new OrchestrationV2ThreadHandoffError({ sourceThreadId: threadId, reason }),
          );
        },
      }).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(liveProjectThreads),
      ),
    ),
  );
});

it.effect(
  "t3_thread_transfer handoff forwards instructions and model, and is refused without starting anything",
  () => {
    const handoffs: Array<ThreadHandoffService.ThreadHandoffInput> = [];
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const call = (args: object, as: McpInvocationContext.McpInvocationScope) =>
        server
          .callTool({ name: "t3_thread_transfer", arguments: { action: "handoff", ...args } })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, as),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const started = yield* call(
        {
          instructions: "Add tests.",
          modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
        },
        scope,
      );
      expect(started.structuredContent).toMatchObject({ threadId: "handed" });
      expect(handoffs[0]).toMatchObject({
        sourceThreadId: threadId,
        mode: "focused",
        instructions: "Add tests.",
        modelSelection: { model: "claude-test" },
      });

      const noCapability = yield* call({}, { ...scope, capabilities: new Set<never>() });
      expect(declaredFailure(noCapability)).toMatchObject({ code: "capability_denied" });
      const readOnly = yield* call(
        { threadId: "other-thread" },
        {
          ...scope,
          thread: undefined,
          client: { sessionId: "client", label: "Client", access: "read-only" },
        },
      );
      expect(declaredFailure(readOnly)).toMatchObject({ code: "capability_denied" });
      expect(handoffs).toHaveLength(1);
    }).pipe(
      Effect.provide(
        layerThreadToolkitWith({
          handoff: (input) => {
            handoffs.push(input);
            return Effect.succeed({ threadId: ThreadId.make("handed") });
          },
        }).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(liveProjectThreads),
        ),
      ),
    );
  },
);
