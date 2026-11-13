import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type Assistant,
  type AssistantIntegrations,
  type AssistantToolAccess,
  DEFAULT_SERVER_SETTINGS,
  IntegrationError,
  type IntegrationErrorReason,
  ProjectId,
  type T3McpServer,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { installLayer } from "../assistants/AskBeforeActing.ts";
import * as AskBeforeActingGate from "../assistants/AskBeforeActingGate.ts";
import * as AssistantDirectory from "../assistants/AssistantDirectory.ts";
import { DecisionService, layer as decisionsLayer } from "../decisions/DecisionService.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IntegrationAuth from "./IntegrationAuth.ts";
import * as IntegrationFetch from "./IntegrationFetch.ts";
import * as IntegrationProxy from "./IntegrationProxy.ts";

const LINEAR = "https://mcp.linear.app/mcp";
const ASSISTANT_THREAD = ThreadId.make("assistant:sam:1");
const PLAIN_THREAD = ThreadId.make("thread:plain");

const integration = (availability: "assistants" | "all"): T3McpServer => ({
  enabled: true,
  transport: "http",
  url: LINEAR,
  headers: {},
  integration: { catalogId: "linear", auth: "oauth", availability },
});

/** An MCP server that needs its own bearer and session id, answering JSON and SSE. */
const makeUpstream = () => {
  interface Seen {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: { id?: unknown; method?: string; params?: { name?: string } } | undefined;
  }
  const seen: Array<Seen> = [];
  const state = { validToken: "at-1", scopeDenied: false, down: false };
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", ...headers },
    });
  const send: IntegrationFetch.IntegrationFetchFn = async (url, init) => {
    expect(String(url)).toBe(LINEAR);
    expect(init?.redirect).toBe("manual");
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text =
      init?.body === undefined ? undefined : new TextDecoder().decode(init.body as Uint8Array);
    const body = text === undefined ? undefined : (JSON.parse(text) as Seen["body"] & {});
    seen.push({ method: init?.method ?? "GET", headers, body });
    if (state.down) throw new Error("connection reset");
    if (headers.authorization !== `Bearer ${state.validToken}`) {
      return new Response("{}", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://x/.well-known"' },
      });
    }
    if (init?.method === "GET") {
      return new Response("event: message\ndata: hello\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (body?.method === "initialize") {
      return json(
        { jsonrpc: "2.0", id: body?.id, result: { protocolVersion: "2025-06-18" } },
        { "mcp-session-id": "s-1", "x-upstream-secret": "nope", "set-cookie": "a=b" },
      );
    }
    if (headers["mcp-session-id"] !== "s-1") return new Response("no session", { status: 400 });
    if (body?.method === "tools/list") {
      const result = {
        tools: [
          { name: "search", annotations: { readOnlyHint: true } },
          { name: "create_issue", annotations: { readOnlyHint: false } },
          { name: "list_teams", annotations: { readOnlyHint: true } },
        ],
      };
      // Split across chunks the way a real stream arrives.
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body?.id, result })}\n\n`;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event.slice(0, 40)));
            controller.enqueue(encoder.encode(event.slice(40)));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (body?.method === "tools/call") {
      if (state.scopeDenied) {
        return new Response("{}", {
          status: 403,
          headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: body?.id,
        result: { content: [{ type: "text", text: `ran ${body?.params?.name}` }] },
      });
    }
    return json({ jsonrpc: "2.0", id: body?.id, result: {} });
  };
  return { seen, state, send, calls: () => seen.filter((r) => r.body?.method === "tools/call") };
};

interface Setup {
  readonly access?: AssistantToolAccess;
  readonly askBeforeActing?: boolean;
  readonly integrations?: AssistantIntegrations;
  readonly availability?: "assistants" | "all";
  readonly tokenFailure?: IntegrationErrorReason;
}

const setup = (options: Setup = {}) =>
  Effect.gen(function* () {
    const upstream = makeUpstream();
    const marks: Array<string> = [];
    const auth = { current: "at-1", refreshes: 0, failure: options.tokenFailure };
    const assistant = {
      id: "sam",
      name: "Sam",
      projectId: ProjectId.make("project:1"),
      toolAccess: options.access ?? "workspace-write",
      askBeforeActing: options.askBeforeActing ?? false,
      integrations: options.integrations ?? { mode: "all" },
    } as unknown as Assistant;
    const mcpServers: Record<string, T3McpServer> = {
      linear: integration(options.availability ?? "all"),
      remote: { enabled: true, transport: "http", url: LINEAR, headers: {} },
    };
    const context = yield* Layer.build(
      IntegrationProxy.layer.pipe(
        Layer.provideMerge(installLayer),
        Layer.provideMerge(AskBeforeActingGate.gateLayer),
        Layer.provideMerge(decisionsLayer),
        Layer.provide(
          Layer.mergeAll(
            SqlitePersistence.layerMemory,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService)({}),
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(
                  token === "assistant-token" || token === "plain-token"
                    ? ({
                        thread: {
                          threadId: token === "assistant-token" ? ASSISTANT_THREAD : PLAIN_THREAD,
                        },
                      } as never)
                    : undefined,
                ),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, mcpServers })),
            }),
            Layer.mock(AssistantDirectory.AssistantDirectory)({
              forThread: (threadId) =>
                Effect.succeed(
                  threadId === ASSISTANT_THREAD
                    ? Option.some({ assistant, current: true })
                    : Option.none(),
                ),
            }),
            Layer.mock(IntegrationAuth.IntegrationAuth)({
              catalog: [
                { id: "linear", name: "Linear", readOnlyTools: ["list_projects"] } as never,
              ],
              accessToken: (_name, rejected) =>
                Effect.suspend(() => {
                  if (auth.failure !== undefined) {
                    return Effect.fail(new IntegrationError({ reason: auth.failure }));
                  }
                  if (rejected !== undefined && rejected === auth.current) {
                    auth.refreshes += 1;
                    auth.current = `at-${auth.refreshes + 1}`;
                  }
                  return Effect.succeed(auth.current);
                }),
              markRejected: (name) => Effect.sync(() => void marks.push(`rejected:${name}`)),
              markNeedsMoreAccess: (name, scope) =>
                Effect.sync(() => void marks.push(`more:${name}:${scope}`)),
            }),
            Layer.succeed(
              IntegrationFetch.IntegrationFetch,
              IntegrationFetch.IntegrationFetch.of({ fetch: upstream.send }),
            ),
          ),
        ),
      ),
    );
    const proxy = Context.get(context, IntegrationProxy.IntegrationProxy);
    const decisions = Context.get(context, DecisionService);
    let nextId = 1;
    const request = (input: {
      readonly body?: unknown;
      readonly method?: string;
      readonly token?: string;
      readonly name?: string;
      readonly headers?: Record<string, string>;
    }) =>
      proxy.handle({
        name: input.name ?? "linear",
        token: input.token ?? "assistant-token",
        method: input.method ?? "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "s-1",
          authorization: "Bearer assistant-token",
          cookie: "t3=session",
          ...input.headers,
        },
        body:
          input.body === undefined
            ? undefined
            : new TextEncoder().encode(JSON.stringify(input.body)),
      });
    const call = (tool: string, args: unknown = { title: "Bug" }, token?: string) =>
      request({
        body: {
          jsonrpc: "2.0",
          id: nextId++,
          method: "tools/call",
          params: { name: tool, arguments: args },
        },
        ...(token === undefined ? {} : { token }),
      }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())));
    const listTools = (token?: string) =>
      request({
        body: { jsonrpc: "2.0", id: nextId++, method: "tools/list" },
        ...(token === undefined ? {} : { token }),
      }).pipe(Effect.flatMap((response) => Effect.promise(() => response.text())));
    const openDecisions = decisions
      .list({ threadId: ASSISTANT_THREAD })
      .pipe(Effect.map((all) => all.filter((decision) => decision.status === "open")));
    const rawPost = (text: string) =>
      proxy
        .handle({
          name: "linear",
          token: "assistant-token",
          method: "POST",
          headers: {},
          body: new TextEncoder().encode(text),
        })
        .pipe(Effect.map((response) => response.status));
    return { upstream, marks, auth, request, call, listTools, rawPost, decisions, openDecisions };
  });

const textOf = (reply: unknown) =>
  (reply as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;

it.each([
  ["read only blocks a write", { toolAccess: "read-only", askBeforeActing: false }, true, "block"],
  [
    "read only forwards a read",
    { toolAccess: "read-only", askBeforeActing: false },
    false,
    "forward",
  ],
  ["read only wins over ask", { toolAccess: "read-only", askBeforeActing: true }, true, "block"],
  ["ask before acting asks at full", { toolAccess: "full", askBeforeActing: true }, true, "ask"],
  [
    "ask before acting forwards a read",
    { toolAccess: "full", askBeforeActing: true },
    false,
    "forward",
  ],
  ["workspace write asks", { toolAccess: "workspace-write", askBeforeActing: false }, true, "ask"],
  ["full access forwards", { toolAccess: "full", askBeforeActing: false }, true, "forward"],
  ["another thread leaves it to the provider", undefined, true, "forward"],
] as const)("authority: %s", (_, assistant, write, decision) => {
  expect(IntegrationProxy.decideToolCall(assistant, write)).toBe(decision);
});

it("a tool is a write unless annotated read-only or listed in the catalog", () => {
  const annotated = new Map([
    ["search", true],
    ["create_issue", false],
  ]);
  expect(IntegrationProxy.isWriteTool("search", annotated, undefined)).toBe(false);
  expect(IntegrationProxy.isWriteTool("create_issue", annotated, undefined)).toBe(true);
  expect(IntegrationProxy.isWriteTool("never_listed", annotated, undefined)).toBe(true);
  expect(IntegrationProxy.isWriteTool("list_projects", undefined, ["list_projects"])).toBe(false);
});

it("the arguments hash ignores key order and nothing else", () => {
  expect(IntegrationProxy.argumentsHash({ a: 1, b: { c: [1, 2], d: null } })).toBe(
    IntegrationProxy.argumentsHash({ b: { d: null, c: [1, 2] }, a: 1 }),
  );
  expect(IntegrationProxy.argumentsHash({ a: 1 })).not.toBe(
    IntegrationProxy.argumentsHash({ a: 2 }),
  );
  expect(IntegrationProxy.argumentsHash(undefined)).toBe(IntegrationProxy.argumentsHash({}));
});

it("reads insufficient_scope challenges", () => {
  expect(
    IntegrationProxy.insufficientScope('Bearer error="insufficient_scope", scope="a b"'),
  ).toEqual({
    scope: "a b",
  });
  expect(IntegrationProxy.insufficientScope("Bearer error=insufficient_scope")).toEqual({
    scope: undefined,
  });
  expect(IntegrationProxy.insufficientScope('Bearer error="invalid_token"')).toBeNull();
  expect(IntegrationProxy.insufficientScope(null)).toBeNull();
});

it.effect("passes streamable HTTP and SSE through with the upstream token, never the T3 one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "full" });
      const init = yield* env.request({
        body: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
        headers: { "mcp-session-id": "" },
      });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBe("s-1");
      expect(init.headers.get("x-upstream-secret")).toBeNull();
      expect(init.headers.get("set-cookie")).toBeNull();
      expect(yield* Effect.promise(() => init.json())).toMatchObject({ id: 0 });

      const listed = yield* env.listTools();
      expect(listed).toContain('"name":"create_issue"');
      expect(listed.startsWith("event: message\ndata: ")).toBe(true);

      const stream = yield* env.request({ method: "GET" });
      expect(stream.headers.get("content-type")).toBe("text/event-stream");
      expect(yield* Effect.promise(() => stream.text())).toBe("event: message\ndata: hello\n\n");
      expect((yield* env.request({ method: "DELETE" })).status).toBe(204);

      for (const request of env.upstream.seen) {
        expect(request.headers.authorization).toBe("Bearer at-1");
        expect(request.headers.cookie).toBeUndefined();
      }
      expect(env.upstream.seen.at(-1)?.headers["mcp-session-id"]).toBe("s-1");
    }),
  ),
);

it.effect("only a provider session reaches an integration its thread may use", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ integrations: { mode: "selected", names: ["other"] } });
      expect((yield* env.request({ token: "outside-token", body: {} })).status).toBe(401);
      expect((yield* env.request({ name: "remote", body: {} })).status).toBe(404);
      expect((yield* env.request({ name: "missing", body: {} })).status).toBe(404);
      // The assistant did not select it.
      expect((yield* env.request({ body: {} })).status).toBe(404);
      const assistantsOnly = yield* setup({ availability: "assistants" });
      expect((yield* assistantsOnly.request({ token: "plain-token", body: {} })).status).toBe(404);
      expect(env.upstream.seen).toEqual([]);
      expect(assistantsOnly.upstream.seen).toEqual([]);
    }),
  ),
);

it.effect("read only blocks writes without reaching the service and forwards reads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "read-only" });
      // Before tools/list nothing is known, so every tool counts as a write.
      expect(textOf(yield* env.call("search"))).toMatchObject({ isError: true });
      yield* env.listTools();
      const blocked = textOf(yield* env.call("create_issue"));
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0]!.text).toBe(
        IntegrationProxy.readOnlyBlocked("Linear", "create_issue"),
      );
      expect(textOf(yield* env.call("search")).content[0]!.text).toBe("ran search");
      expect(textOf(yield* env.call("list_projects")).content[0]!.text).toBe("ran list_projects");
      expect(env.upstream.calls().map((r) => r.body?.params?.name)).toEqual([
        "search",
        "list_projects",
      ]);
      expect(yield* env.openDecisions).toEqual([]);
    }),
  ),
);

it.effect(
  "ask before acting: one decision, the approved retry forwards once, then asks again",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup({ access: "full", askBeforeActing: true });
        yield* env.listTools();
        for (const _ of [1, 2]) {
          expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe(
            AskBeforeActingGate.TOOL_WAITING_FOR_APPROVAL,
          );
        }
        const [decision, ...rest] = yield* env.openDecisions;
        expect(rest).toEqual([]);
        expect(decision!.title).toBe("Sam wants to use Linear: create_issue");
        // Reads never ask.
        expect(textOf(yield* env.call("search")).content[0]!.text).toBe("ran search");
        expect(env.upstream.calls()).toHaveLength(1);

        yield* env.decisions.answer({ decisionId: decision!.id, optionId: "accept" });
        // The same call in another key order is the same call.
        expect(textOf(yield* env.call("create_issue", { title: "Bug" })).content[0]!.text).toBe(
          "ran create_issue",
        );
        expect(env.upstream.calls()).toHaveLength(2);
        expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe(
          AskBeforeActingGate.TOOL_WAITING_FOR_APPROVAL,
        );
        expect(env.upstream.calls()).toHaveLength(2);
        const [second] = yield* env.openDecisions;
        yield* env.decisions.answer({ decisionId: second!.id, optionId: "deny" });
        expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe(
          AskBeforeActingGate.TOOL_DECLINED,
        );
        expect(env.upstream.calls()).toHaveLength(2);
      }),
    ),
);

it.effect("workspace write asks for writes; full access and other threads forward", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* setup({ access: "workspace-write" });
      yield* workspace.listTools();
      expect(textOf(yield* workspace.call("create_issue")).content[0]!.text).toBe(
        AskBeforeActingGate.TOOL_WAITING_FOR_APPROVAL,
      );
      const full = yield* setup({ access: "full" });
      yield* full.listTools();
      expect(textOf(yield* full.call("create_issue")).content[0]!.text).toBe("ran create_issue");
      // Another thread: the provider asks under its runtime mode, the proxy forwards.
      const plain = yield* setup({ access: "read-only" });
      expect(textOf(yield* plain.call("create_issue", {}, "plain-token")).content[0]!.text).toBe(
        "ran create_issue",
      );
      expect(yield* plain.openDecisions).toEqual([]);
    }),
  ),
);

it.effect("a 401 refreshes once and retries; a second 401 needs sign-in", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "full" });
      env.upstream.state.validToken = "at-2";
      expect(textOf(yield* env.call("search")).content[0]!.text).toBe("ran search");
      expect(env.auth.refreshes).toBe(1);
      expect(env.upstream.seen.map((r) => r.headers.authorization)).toEqual([
        "Bearer at-1",
        "Bearer at-2",
      ]);

      env.upstream.state.validToken = "never";
      const rejected = textOf(yield* env.call("search"));
      expect(rejected).toMatchObject({ isError: true });
      expect(rejected.content[0]!.text).toBe(IntegrationProxy.needsSignIn("Linear"));
      expect(env.marks).toEqual(["rejected:linear"]);
      expect(env.auth.refreshes).toBe(2);
    }),
  ),
);

it.effect(
  "a token that needs sign-in answers with a tool error and never reaches the service",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const env = yield* setup({ access: "full", tokenFailure: "needs-sign-in" });
        const reply = textOf(yield* env.call("search"));
        expect(reply).toMatchObject({ isError: true });
        expect(reply.content[0]!.text).toContain("reconnect Linear");
        const listed = yield* env.request({
          body: { jsonrpc: "2.0", id: 9, method: "tools/list" },
        });
        expect(yield* Effect.promise(() => listed.json())).toMatchObject({
          id: 9,
          error: { message: IntegrationProxy.needsSignIn("Linear") },
        });
        const stream = yield* env.request({ method: "GET" });
        expect(stream.status).toBe(502);
        const broken = yield* setup({ access: "full", tokenFailure: "storage-failed" });
        expect(textOf(yield* broken.call("search")).content[0]!.text).toBe(
          IntegrationProxy.serviceUnreachable("Linear"),
        );
        expect(env.upstream.seen).toEqual([]);
      }),
    ),
);

it.effect("an approval survives a call that never reached the service", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "full", askBeforeActing: true });
      yield* env.call("create_issue");
      const [decision] = yield* env.openDecisions;
      yield* env.decisions.answer({ decisionId: decision!.id, optionId: "accept" });
      env.auth.failure = "needs-sign-in";
      yield* env.call("create_issue");
      env.auth.failure = undefined;
      expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe("ran create_issue");
      // A connection that fails may have acted, so its approval is spent.
      env.upstream.state.down = true;
      yield* env.call("create_issue");
      const [again] = yield* env.openDecisions;
      yield* env.decisions.answer({ decisionId: again!.id, optionId: "accept" });
      expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe(
        IntegrationProxy.serviceUnreachable("Linear"),
      );
      expect(textOf(yield* env.call("create_issue")).content[0]!.text).toBe(
        AskBeforeActingGate.TOOL_WAITING_FOR_APPROVAL,
      );
    }),
  ),
);

it.effect("insufficient_scope needs more access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "full" });
      env.upstream.state.scopeDenied = true;
      const reply = textOf(yield* env.call("list_projects"));
      expect(reply.content[0]!.text).toBe(IntegrationProxy.needsMoreAccess("Linear"));
      expect(env.marks).toEqual(["more:linear:admin"]);
    }),
  ),
);

it.effect("batched tool calls never pass the gate; other batches and bad JSON are handled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* setup({ access: "full" });
      const batch = yield* env.request({
        body: [
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_issue" } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
        ],
      });
      expect(yield* Effect.promise(() => batch.json())).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: IntegrationProxy.BATCHED_TOOL_CALLS }],
            isError: true,
          },
        },
      ]);
      expect(env.upstream.seen).toEqual([]);
      yield* env.request({ body: [{ jsonrpc: "2.0", id: 2, method: "ping" }] });
      expect(env.upstream.seen).toHaveLength(1);
      expect(yield* env.rawPost("{not json")).toBe(400);
      expect(env.upstream.seen).toHaveLength(1);
    }),
  ),
);

it.effect("the route hands the name, bearer and body to the proxy, beside /mcp", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const seen: Array<IntegrationProxy.ProxyRequest> = [];
      const routes = Layer.mergeAll(
        IntegrationProxy.routeLayer,
        HttpRouter.add("POST", "/mcp", HttpServerResponse.text("t3 mcp")),
      ).pipe(
        Layer.provide(
          Layer.mock(IntegrationProxy.IntegrationProxy)({
            handle: (request) =>
              Effect.sync(() => {
                seen.push(request);
                return new Response("event: message\ndata: hi\n\n", {
                  status: 200,
                  headers: { "content-type": "text/event-stream", "mcp-session-id": "s-9" },
                });
              }),
          }),
        ),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
      );
      return { seen, web: HttpRouter.toWebHandler(routes, { disableLogger: true }) };
    }),
    ({ seen, web }) =>
      Effect.promise(async () => {
        const post = await web.handler(
          new Request("http://127.0.0.1/mcp/integrations/linear", {
            method: "POST",
            headers: { authorization: "Bearer thread-token", "mcp-session-id": "s-9" },
            body: '{"jsonrpc":"2.0"}',
          }),
          Context.empty(),
        );
        expect(post.headers.get("mcp-session-id")).toBe("s-9");
        expect(await post.text()).toBe("event: message\ndata: hi\n\n");
        const get = await web.handler(
          new Request("http://127.0.0.1/mcp/integrations/notion", { method: "GET" }),
          Context.empty(),
        );
        await get.text();
        const mcp = await web.handler(
          new Request("http://127.0.0.1/mcp", { method: "POST", body: "{}" }),
          Context.empty(),
        );
        expect(await mcp.text()).toBe("t3 mcp");
        expect(seen.map((r) => [r.name, r.token, r.method, r.headers["mcp-session-id"]])).toEqual([
          ["linear", "thread-token", "POST", "s-9"],
          ["notion", "", "GET", undefined],
        ]);
        expect(new TextDecoder().decode(seen[0]!.body)).toBe('{"jsonrpc":"2.0"}');
        expect(seen[1]!.body).toBeUndefined();
      }),
    ({ web }) => Effect.promise(() => web.dispose()),
  ),
);
