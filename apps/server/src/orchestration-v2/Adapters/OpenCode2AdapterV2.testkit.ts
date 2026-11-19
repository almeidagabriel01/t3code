import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderReplayEntry,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Stream from "effect/Stream";

import * as OpenCode2Client from "@t3tools/provider-opencode/server/v2/OpenCode2Client";
import * as OpenCode2Server from "@t3tools/provider-opencode/server/v2/OpenCode2Server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { startNextTurnAtTurnEnd } from "@t3tools/provider-testing/turnEndRace";
import { OPENCODE_PROVIDER } from "@t3tools/provider-opencode/testing";
import {
  OpenCodeReplayController,
  OpenCodeReplayTranscriptDecodeError,
} from "./OpenCodeAdapterV2.testkit.ts";
import * as OpenCode2Adapter from "@t3tools/provider-opencode/server/v2/adapter";

export const OPENCODE2_HTTP_PROTOCOL = "opencode2-http.sse" as const;
const BASE_URL = "http://opencode2.replay";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const OpenCode2ReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OPENCODE_PROVIDER),
  protocol: Schema.Literal(OPENCODE2_HTTP_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type OpenCode2ReplayTranscript = typeof OpenCode2ReplayTranscript.Type;
const decodeOpenCode2ReplayTranscript = Schema.decodeUnknownEffect(OpenCode2ReplayTranscript);

const operationOf = (
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
) => {
  if (method === "GET" && path === "/api/experimental/job" && query.kind === "image")
    return { type: "imageJobs", input: query };
  if (method === "GET" && path.startsWith("/api/fs/read/"))
    return { type: "image.read", input: { path, ...query } };
  const rpc = /^\/api\/rpc\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === "POST" && rpc !== null)
    return {
      type: "rpc.call",
      input: { rpcID: rpc[1], method: rpc[2], ...query, ...(body as object) },
    };
  if (method === "GET" && path === "/api/experimental/job")
    return { type: "job.list", input: query };
  const shell = /^\/api\/shell(?:\/([^/]+)(\/output)?)?$/.exec(path);
  if (shell !== null) {
    const input = { ...(shell[1] === undefined ? {} : { id: shell[1] }), ...query };
    return {
      type: `shell.${method === "DELETE" ? "remove" : shell[2] ? "output" : shell[1] ? "get" : "list"}`,
      input,
    };
  }
  const session = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
  if (method === "GET" && path === "/api/event") return { type: "event.subscribe" };
  if (method === "GET" && path === "/api/model") return { type: "model.list", input: query };
  if (method === "GET" && path === "/api/agent") return { type: "agent.list", input: query };
  if (method === "POST" && path === "/api/session") return { type: "session.create", input: body };
  if (method === "GET" && path === "/api/session/active") return { type: "session.active" };
  if (method === "GET" && path === "/api/command") return { type: "command.list", input: query };
  const mcp = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(path);
  if (mcp !== null && method === "PUT") {
    return { type: "mcp.add", input: { server: mcp[1], ...query, ...(body as object) } };
  }
  if (mcp !== null && method === "DELETE") {
    return { type: "mcp.remove", input: { server: mcp[1], ...query } };
  }
  const entry = /^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/([^/]+)$/.exec(
    path,
  );
  if (entry !== null && method === "PUT") {
    return {
      type: "session.instructions.entry.put",
      input: { sessionID: entry[1], key: entry[2], ...(body as object) },
    };
  }
  if (method === "GET" && path === "/api/skill") return { type: "skill.list", input: query };
  if (session !== null) {
    const [, sessionID, rest = ""] = session;
    // The client sends absent optional fields as `null`; recordings omit them.
    const fields = Object.entries((body ?? {}) as Record<string, unknown>).filter(
      ([, value]) => value !== null,
    );
    const input = { sessionID, ...query, ...Object.fromEntries(fields) };
    if (method === "GET" && rest === "") return { type: "session.get", input };
    if (method === "DELETE" && rest === "") return { type: "session.remove", input };
    if (method === "PATCH" && rest === "") return { type: "session.update", input };
    if (method === "POST" && rest === "/prompt") return { type: "session.prompt", input };
    if (method === "POST" && rest === "/command") return { type: "session.command", input };
    if (method === "POST" && rest === "/compact") return { type: "session.compact", input };
    if (method === "POST" && rest === "/interrupt") return { type: "session.interrupt", input };
    if (method === "POST" && rest === "/model") return { type: "session.switchModel", input };
    if (method === "POST" && rest === "/agent") return { type: "session.switchAgent", input };
    if (method === "POST" && rest === "/move") return { type: "session.move", input };
    if (method === "POST" && rest === "/synthetic") return { type: "session.synthetic", input };
    if (method === "POST" && rest === "/fork") return { type: "session.fork", input };
    if (method === "POST" && rest === "/revert/stage") {
      return { type: "session.revert.stage", input };
    }
    if (method === "POST" && rest === "/revert/commit") {
      return { type: "session.revert.commit", input };
    }
    if (method === "DELETE" && rest === "/revert") return { type: "session.revert.clear", input };
    const inbox = /^\/inbox\/([^/]+)$/.exec(rest);
    if (method === "DELETE" && inbox !== null) {
      const inboxID = decodeURIComponent(inbox[1] ?? "");
      return { type: "session.inbox.cancel", input: { ...input, inboxID } };
    }
    if (method === "GET" && rest === "/message") return { type: "message.list", input };
    if (method === "GET" && rest === "/permission") return { type: "permission.list", input };
    if (method === "GET" && rest === "/form") return { type: "session.form.list", input };
    const form = /^\/form\/([^/]+)(\/reply)?$/.exec(rest);
    if (form !== null) {
      const formInput = { ...input, formID: form[1] };
      if (method === "POST" && form[2] !== undefined) {
        return { type: "session.form.reply", input: formInput };
      }
      if (method === "DELETE") return { type: "session.form.cancel", input: formInput };
    }
    const permission = /^\/permission\/([^/]+)\/reply$/.exec(rest);
    if (method === "POST" && permission !== null) {
      return { type: "permission.reply", input: { ...input, requestID: permission[1] } };
    }
  }
  return { type: `${method} ${path}`, input: { ...query, body } };
};

const replayHttpClient = (
  controller: OpenCodeReplayController,
  replayGate: ProviderReplayGate | undefined,
  onPrompt: ((input: unknown) => void) | undefined,
) =>
  HttpClient.make((request, url) =>
    Effect.tryPromise({
      try: async () => {
        if (controller.exited && controller.finished) {
          throw new Error("The replayed OpenCode server has exited.");
        }
        const raw =
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined;
        const query = UrlParams.toRecord(UrlParams.fromInput(url.searchParams));
        const operation = operationOf(
          request.method,
          url.pathname,
          query,
          raw === undefined ? undefined : decodeJson(raw),
        );
        // HTTP streams and requests use separate connections; deliver prior recorded inbound data before matching requests.
        if (operation.type !== "event.subscribe") await controller.untilInboundDelivered();
        if (operation.type === "session.prompt") onPrompt?.(operation.input);
        await controller.expectOutbound(operation);
        if (operation.type === "event.subscribe") {
          controller.exited = false;
          const encoder = new TextEncoder();
          const events = controller.events(undefined, replayGate?.beforeEmit);
          const frames = events[Symbol.asyncIterator]();
          const body = new ReadableStream<Uint8Array>({
            async pull(stream) {
              const next = await frames.next();
              if (next.done === true) stream.close();
              else stream.enqueue(encoder.encode(`data: ${encodeJson(next.value)}\n\n`));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        // Recorded responses are the raw HTTP bodies; `null` is an empty 204.
        const body = await controller.response(operation.type);
        if (typeof body === "object" && body !== null && "imageBase64" in body) {
          return new Response(Buffer.from(String(body.imageBase64), "base64"), {
            headers: { "content-type": "image/png" },
          });
        }
        if (body === "<hang>") return new Promise<Response>(() => {});
        if (typeof body === "object" && body !== null && "status" in body && "body" in body) {
          return new Response(encodeJson(body.body), {
            status: Number(body.status),
            headers: { "content-type": "application/json" },
          });
        }
        return body === null
          ? new Response(null, { status: 204 })
          : new Response(encodeJson(body), { headers: { "content-type": "application/json" } });
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  );

export const replayServer = (
  transcript: ProviderReplayTranscript,
  options?: {
    readonly external?: boolean;
    readonly onPrompt?: (input: unknown) => void;
    readonly replayGate?: ProviderReplayGate;
    readonly borrowers?: { current: number };
  },
) =>
  Effect.gen(function* () {
    const controller = new OpenCodeReplayController(transcript);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        options?.replayGate?.releaseAll();
        controller.assertComplete();
      }),
    );
    const opencode = yield* OpenCode2Client.make.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        replayHttpClient(controller, options?.replayGate, options?.onPrompt),
      ),
    );
    const connection = {
      ...(yield* opencode.connect({ baseUrl: BASE_URL, password: "replay" })),
      url: BASE_URL,
      version: transcript.version,
      external: options?.external ?? false,
    };
    const borrowers = options?.borrowers;
    return OpenCode2Server.OpenCode2Server.of({
      withConnection: (use) =>
        borrowers === undefined
          ? use(connection)
          : Effect.acquireUseRelease(
              Effect.sync(() => {
                borrowers.current += 1;
              }),
              () => use(connection),
              () =>
                Effect.sync(() => {
                  borrowers.current -= 1;
                }),
            ),
    });
  });

const makeReplayAdapter = (
  transcript: ProviderReplayTranscript,
  options?: {
    readonly external?: boolean;
    readonly onPrompt?: (input: unknown) => void;
    readonly replayGate?: ProviderReplayGate;
    readonly borrowers?: { current: number };
  },
) =>
  Effect.gen(function* () {
    const server = yield* replayServer(transcript, options);
    return yield* OpenCode2Adapter.make(ProviderInstanceId.make("opencode")).pipe(
      Effect.provideService(OpenCode2Server.OpenCode2Server, server),
    );
  });

const layerReplayHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerReplayHostWithAttachments = (
  attachmentsDir: string,
  resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>,
) =>
  Layer.effect(
    ProviderHost.ProviderHost,
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      return ProviderHost.ProviderHost.of({
        ...host,
        paths: { ...host.paths, attachmentsDir },
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({ attachmentsDir, attachment }),
        ...(resolveExtractedTextPath === undefined ? {} : { resolveExtractedTextPath }),
      });
    }),
  ).pipe(Layer.provide(layerReplayHost));

function layerRegistry(
  transcript: OpenCode2ReplayTranscript,
  options?: { readonly replayGate?: ProviderReplayGate },
) {
  return Layer.unwrap(
    makeReplayAdapter(transcript, { external: true, ...options }).pipe(
      Effect.map((adapter) => ProviderAdapterRegistry.layerFromAdapters([adapter])),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(layerReplayHost, IdAllocator.layer, NodeServices.layer, NodeCrypto.layer),
    ),
  );
}

export const openCode2ReplayRuntime = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly external?: boolean;
    readonly version?: string;
    readonly onPrompt?: (input: unknown) => void;
    readonly borrowers?: { current: number };
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = options?.fileSystem ?? (yield* FileSystem.FileSystem);
    const adapter = yield* makeReplayAdapter(
      {
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE2_HTTP_PROTOCOL,
        version: options?.version ?? "2.0.18",
        scenario: "opencode2_adapter",
        entries,
      },
      options,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
    return yield* adapter.openSession({
      threadId: ThreadId.make("thread:opencode2-adapter"),
      providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "opencode/big-pickle",
      },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/work/opencode2",
      },
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        options?.attachmentsDir === undefined
          ? layerReplayHost
          : layerReplayHostWithAttachments(
              options.attachmentsDir,
              options.resolveExtractedTextPath,
            ),
        IdAllocator.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

export const OpenCode2OrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  OpenCode2ReplayTranscript,
  OpenCodeReplayTranscriptDecodeError
> = {
  driver: OPENCODE_PROVIDER,
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeOpenCode2ReplayTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeReplayTranscriptDecodeError({
            driver: transcript.provider,
            protocol: transcript.protocol,
            scenario: transcript.scenario,
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: layerRegistry,
};

export const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
export const WORK = "/work/opencode2";
export const instanceId = ProviderInstanceId.make("opencode");
export const threadId = ThreadId.make("thread:opencode2-adapter");

export const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
export const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
export const replyData = (operation: string, data: unknown) => reply(operation, { data });
export const event = (
  type: string,
  data: Record<string, unknown>,
  label?: string,
  version = 1,
): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}0000`,
      created: 1,
      type,
      ...(type.startsWith("rpc.") ? { location: { directory: WORK } } : {}),
      data,
      durable: { ...durable.durable, version },
    },
  },
  ...(label === undefined ? {} : { label }),
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

export const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
];
export const t3Rules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
export const TITLE = "Prime check";
export const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: t3Rules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
export const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

export const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
export const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

export const emptyShellInventory: ReadonlyArray<ProviderReplayEntry> = [
  out("shell.list", "<any>"),
  reply("shell.list", { location: { directory: WORK }, data: [] }),
];

export const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

export const withInstructions = (
  entries: ReadonlyArray<ProviderReplayEntry>,
): ReadonlyArray<ProviderReplayEntry> => {
  const first = entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "type" in entry.frame &&
      ([
        "session.prompt",
        "session.command",
        "session.compact",
        "command.list",
        "skill.list",
        "rpc.call",
      ].includes(String(entry.frame.type)) ||
        ("input" in entry.frame &&
          typeof entry.frame.input === "object" &&
          (entry.frame.input as { key?: unknown } | null)?.key === "t3-code-memory")),
  );
  const after = entries.findIndex(
    (entry, index) =>
      index < first &&
      entry.type === "emit_inbound" &&
      typeof entry.frame === "object" &&
      entry.frame !== null &&
      "operation" in entry.frame &&
      entry.frame.operation === "mcp.add",
  );
  const at = after < 0 ? first : after + 1;
  return first < 0
    ? entries
    : [
        ...entries.slice(0, at),
        out("session.instructions.entry.put", {
          sessionID: SESSION,
          key: "t3-code",
          value: "<any>",
        }),
        reply("session.instructions.entry.put", null),
        ...entries.slice(at),
      ];
};

export const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];

export const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
export const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

export const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

export const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const buildPaths = [
  {
    action: "external_directory",
    resource: "/home/.local/share/opencode/tool-output/*",
    effect: "allow",
  },
];
export const agentList = {
  location: { directory: WORK },
  data: [
    {
      id: "build",
      name: "Build",
      request: { settings: {}, headers: {}, body: {} },
      description: "The default agent.",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...buildPaths],
    },
  ],
};
export const supervisedRules = [
  { action: "shell", resource: "*", effect: "ask" },
  { action: "edit", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
  ...buildPaths,
  ...mcpRules,
];

export const resumed = (
  entries: ReadonlyArray<ProviderReplayEntry>,
  options?: {
    readonly version?: "2.2.1" | "2.2.5" | "2.2.6";
    readonly shellRecovery?: ReadonlyArray<ProviderReplayEntry>;
    readonly lastRunOrdinal?: number;
    readonly goal?: OrchestrationV2ProviderThread["goal"];
    readonly external?: boolean;
    readonly supervised?: boolean;
    readonly replayGate?: ProviderReplayGate;
    readonly attachmentsDir?: string;
    readonly resolveExtractedTextPath?: (path: string) => Effect.Effect<string | undefined>;
    readonly fileSystem?: FileSystem.FileSystem;
    readonly onPrompt?: (input: unknown) => void;
    readonly borrowers?: { current: number };
  },
) =>
  Effect.gen(function* () {
    const runtime = yield* openCode2ReplayRuntime(
      [
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        ...(options?.version === "2.2.5" || options?.version === "2.2.6"
          ? [out("rpc.call", "<any>"), reply("rpc.call", { output: null })]
          : []),
        ...(options?.shellRecovery ??
          (options?.version === undefined
            ? []
            : [
                ...(options.version === "2.2.6"
                  ? [out("job.list", { kind: "shell" }), reply("job.list", { data: [] })]
                  : emptyShellInventory),
              ])),
        ...withInstructions([
          ...(options?.supervised === true
            ? [
                out("agent.list", "<any>"),
                reply("agent.list", agentList),
                out("session.update", { sessionID: SESSION, permissions: supervisedRules }),
                reply("session.update", null),
              ]
            : []),
          ...entries,
        ]),
      ],
      {
        ...(options?.version === undefined ? {} : { version: options.version }),
        ...(options?.borrowers === undefined ? {} : { borrowers: options.borrowers }),
        ...(options?.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
        ...(options?.onPrompt === undefined ? {} : { onPrompt: options.onPrompt }),
        ...(options?.external === undefined ? {} : { external: options.external }),
        ...(options?.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        ...(options?.attachmentsDir === undefined
          ? {}
          : { attachmentsDir: options.attachmentsDir }),
        ...(options?.resolveExtractedTextPath === undefined
          ? {}
          : { resolveExtractedTextPath: options.resolveExtractedTextPath }),
      },
    );
    const thread = yield* runtime.resumeThread({
      providerThread: {
        ...providerThread(yield* DateTime.now),
        ...(options?.lastRunOrdinal === undefined
          ? {}
          : { lastRunOrdinal: options.lastRunOrdinal }),
        ...(options?.goal === undefined ? {} : { goal: options.goal }),
      },
      threadId,
      modelSelection: bigPickle,
      runtimePolicy: policy(options?.supervised === true ? "approval-required" : "full-access"),
    });
    return { runtime, thread };
  });
export const openCode2TurnSlotRace = Effect.gen(function* () {
  // The session forks its inbound frame reader when it opens, so it opens under the race's
  // scheduler, inside startFirst.
  const opened = yield* Deferred.make<Effect.Success<ReturnType<typeof resumed>>>();
  const startOn = (session: Effect.Success<ReturnType<typeof resumed>>) =>
    session.runtime.startTurn(turnInput(session.thread));
  const exit = yield* startNextTurnAtTurnEnd({
    events: Stream.unwrap(Effect.map(Deferred.await(opened), (session) => session.runtime.events)),
    startFirst: Effect.gen(function* () {
      const session = yield* resumed([
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
        out("session.prompt", { sessionID: SESSION, text: "<any>" }),
        promptAccepted,
      ]);
      yield* Deferred.succeed(opened, session);
      return yield* startOn(session);
    }),
    // The script ends the first turn as soon as its prompt is accepted.
    endFirst: Effect.void,
    startNext: Effect.flatMap(Deferred.await(opened), startOn),
  });
  return { exit };
}).pipe(Effect.provide(McpProviderSessions.layer), Effect.scoped);
