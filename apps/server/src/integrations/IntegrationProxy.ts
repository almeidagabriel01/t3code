// Relays foreign MCP payloads verbatim; schema decoding would reject or rewrite them.
// @effect-diagnostics globalJsonInEffect:off
// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hash.
import * as NodeCrypto from "node:crypto";

import {
  type Assistant,
  type AssistantToolAccess,
  INTEGRATIONS_PROXY_PATH_PREFIX,
  type IntegrationError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AskBeforeActingGate from "../assistants/AskBeforeActingGate.ts";
import * as AssistantDirectory from "../assistants/AssistantDirectory.ts";
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { t3ServerAllowed } from "../mcpServers/GlobalMcpConnectors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IntegrationAuth from "./IntegrationAuth.ts";
import * as IntegrationFetch from "./IntegrationFetch.ts";

/** Who decides a remote tool call, by the assistant's access (the authority table, INT-17..21). */
export type ToolCallDecision = "forward" | "block" | "ask";

export const decideToolCall = (
  assistant: Pick<Assistant, "toolAccess" | "askBeforeActing"> | undefined,
  write: boolean,
): ToolCallDecision => {
  // Other threads: the provider asks under the thread's runtime mode, as for any MCP tool.
  if (assistant === undefined || !write) return "forward";
  if (assistant.toolAccess === "read-only") return "block";
  if (assistant.askBeforeActing) return "ask";
  return (assistant.toolAccess satisfies AssistantToolAccess) === "full" ? "forward" : "ask";
};

/** Fail closed (D8): a write unless the server annotates it read-only or the catalog lists it. */
export const isWriteTool = (
  tool: string,
  annotated: ReadonlyMap<string, boolean> | undefined,
  readOnlyTools: ReadonlyArray<string> | undefined,
): boolean => annotated?.get(tool) !== true && readOnlyTools?.includes(tool) !== true;

const canonicalJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .toSorted()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");

/** The same arguments in any key order share one approval; `_meta` and progress tokens don't count. */
export const argumentsHash = (args: unknown): string =>
  NodeCrypto.createHash("sha256")
    .update(canonicalJson(args ?? {}))
    .digest("hex");

const ARGS_PREVIEW_CHARS = 1_500;
const MAX_LEARNED_TEXT = 4 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
];
const RETURNED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];
/** Answers that mean the service itself is down, not that it refused the request. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
const LEARN_TOOLS_BODY = new TextEncoder().encode(
  JSON.stringify({ jsonrpc: "2.0", id: "t3-learn-tools", method: "tools/list" }),
);

export const readOnlyBlocked = (service: string, tool: string) =>
  `Read only blocks this action: "${tool}" can change data in ${service}. Do not try another way; if it is needed, ask the user to change this assistant's tool access.`;
export const needsSignIn = (service: string) =>
  `${service} needs the user to sign in again. Ask them to reconnect ${service} in Settings → Integrations; do not retry until they do.`;
export const needsMoreAccess = (service: string) =>
  `${service} needs more access for this action. Ask the user to press Reconnect for ${service} in Settings → Integrations.`;
export const serviceUnreachable = (service: string) =>
  `${service} didn't respond. Try again later.`;
export const BATCHED_TOOL_CALLS = "Call integration tools one at a time, not in a batch.";

class UpstreamUnreachable extends Schema.TaggedError<UpstreamUnreachable>()("UpstreamUnreachable", {
  cause: Schema.Defect(),
}) {}

const parseJson = (bytes: Uint8Array | undefined): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())));
  } catch {
    return Option.none();
  }
};

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
  readonly result?: { readonly tools?: unknown };
}

const asMessage = (value: unknown): JsonRpcMessage | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRpcMessage)
    : undefined;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** A tool error the model reads as the call's result, not a transport failure. */
const toolError = (id: unknown, text: string) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], isError: true },
});

/** The reply to one message the proxy will not forward. */
const refusal = (message: JsonRpcMessage | undefined, text: string) =>
  message?.id === undefined
    ? new Response(text, { status: 502, headers: { "cache-control": "no-store" } })
    : jsonResponse(
        message.method === "tools/call"
          ? toolError(message.id, text)
          : { jsonrpc: "2.0", id: message.id, error: { code: -32001, message: text } },
      );

/** Reads `tools/list` results as they stream through, unchanged, to learn read-only annotations. */
const learnToolAnnotations = (
  body: ReadableStream<Uint8Array>,
  sse: boolean,
  learn: (tools: ReadonlyArray<unknown>) => void,
) => {
  const decoder = new TextDecoder();
  let text = "";
  const parse = (json: string) => {
    try {
      const tools = asMessage(JSON.parse(json))?.result?.tools;
      if (Array.isArray(tools)) learn(tools);
    } catch {
      // Not a JSON-RPC message; the client gets it unchanged.
    }
  };
  const drainEvents = () => {
    const events = text.split(/\r?\n\r?\n/);
    text = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) parse(data);
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (text.length > MAX_LEARNED_TEXT) return;
        text += decoder.decode(chunk, { stream: true });
        if (sse) drainEvents();
      },
      flush() {
        if (sse) {
          text += "\n\n";
          drainEvents();
        } else if (text.length <= MAX_LEARNED_TEXT) {
          parse(text);
        }
      },
    }),
  );
};

/** `scope` from `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, if it says so. */
export const insufficientScope = (header: string | null): { scope: string | undefined } | null => {
  if (header === null || !/error="?insufficient_scope"?/i.test(header)) return null;
  return { scope: /scope="([^"]*)"/i.exec(header)?.[1] };
};

export interface ProxyRequest {
  readonly name: string;
  /** The bearer the provider presented: its thread's T3 MCP session token. */
  readonly token: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array<ArrayBuffer> | undefined;
}

export class IntegrationProxy extends Context.Service<
  IntegrationProxy,
  { readonly handle: (request: ProxyRequest) => Effect.Effect<Response> }
>()("t3/integrations/IntegrationProxy") {}

const make = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const directory = yield* AssistantDirectory.AssistantDirectory;
  const auth = yield* IntegrationAuth.IntegrationAuth;
  const gate = yield* AskBeforeActingGate.AskBeforeActingGate;
  const { fetch } = yield* IntegrationFetch.IntegrationFetch;
  // Read-only hints from `tools/list` per integration; a tool never listed counts as a write.
  const annotations = new Map<string, Map<string, boolean>>();
  const learning = new Map<string, Deferred.Deferred<void>>();

  const learn = (name: string) => (tools: ReadonlyArray<unknown>) => {
    const known = annotations.get(name) ?? new Map<string, boolean>();
    for (const tool of tools) {
      const entry = tool as { name?: unknown; annotations?: { readOnlyHint?: unknown } };
      if (typeof entry?.name === "string") {
        known.set(entry.name, entry.annotations?.readOnlyHint === true);
      }
    }
    annotations.set(name, known);
  };

  const send = (url: string, request: ProxyRequest, token: string) =>
    Effect.tryPromise({
      try: (signal) => {
        const headers = new Headers();
        for (const key of FORWARDED_REQUEST_HEADERS) {
          const value = request.headers[key];
          if (value !== undefined) headers.set(key, value);
        }
        headers.set("authorization", `Bearer ${token}`);
        return fetch(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          // A redirect would carry the upstream token to another origin; the client sees the 3xx.
          redirect: "manual",
          signal,
        });
      },
      catch: (cause) => new UpstreamUnreachable({ cause }),
    });

  const sendTracked = (name: string, url: string, request: ProxyRequest, token: string) =>
    send(url, request, token).pipe(
      Effect.option,
      Effect.tap((response) =>
        auth.reportReachable(
          name,
          Option.isSome(response) && !UNAVAILABLE_STATUSES.has(response.value.status),
        ),
      ),
    );

  const discard = (response: Response) =>
    Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

  /**
   * Upstream with a fresh token, one refresh and retry on 401, and status kept for the UI. `acted`
   * is false only when the service certainly did not act (no token, refused sign-in or scope).
   */
  const forward = Effect.fn("IntegrationProxy.forward")(function* (
    name: string,
    url: string,
    service: string,
    request: ProxyRequest,
    message: JsonRpcMessage | undefined,
    learnTools: boolean,
  ) {
    const signInFailed = (error: IntegrationError) =>
      Effect.succeed(
        refusal(
          message,
          error.reason === "storage-failed" ? serviceUnreachable(service) : needsSignIn(service),
        ),
      );
    const token = yield* auth.accessToken(name).pipe(Effect.result);
    if (token._tag === "Failure") {
      return { response: yield* signInFailed(token.failure), acted: false };
    }
    let response = yield* sendTracked(name, url, request, token.success);
    if (Option.isSome(response) && response.value.status === 401) {
      yield* discard(response.value);
      const fresh = yield* auth.accessToken(name, token.success).pipe(Effect.result);
      if (fresh._tag === "Failure") {
        return { response: yield* signInFailed(fresh.failure), acted: false };
      }
      response = yield* sendTracked(name, url, request, fresh.success);
      if (Option.isSome(response) && response.value.status === 401) {
        yield* discard(response.value);
        yield* auth.markRejected(name).pipe(Effect.ignore);
        return { response: refusal(message, needsSignIn(service)), acted: false };
      }
    }
    if (Option.isNone(response)) {
      yield* Effect.logWarning("Integration did not respond", { integration: name });
      // The request may have landed before the connection failed, so it counts as acted on.
      return { response: refusal(message, serviceUnreachable(service)), acted: true };
    }
    const upstream = response.value;
    const stepUp =
      upstream.status === 403 ? insufficientScope(upstream.headers.get("www-authenticate")) : null;
    if (stepUp !== null) {
      yield* discard(upstream);
      yield* auth.markNeedsMoreAccess(name, stepUp.scope).pipe(Effect.ignore);
      return { response: refusal(message, needsMoreAccess(service)), acted: false };
    }
    const headers = new Headers();
    for (const key of RETURNED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(key);
      if (value !== null) headers.set(key, value);
    }
    const body =
      learnTools && upstream.body !== null
        ? learnToolAnnotations(
            upstream.body,
            (upstream.headers.get("content-type") ?? "").includes("text/event-stream"),
            learn(name),
          )
        : upstream.body;
    return {
      response: new Response(body, { status: upstream.status, headers }),
      acted: true,
    };
  });

  /**
   * The provider listed tools before a restart and never lists again, so the proxy asks the
   * service itself, once per integration at a time, in the provider's own MCP session.
   * ponytail: first page only; a tool on a later page stays a write until the provider lists.
   */
  const learnFromService = Effect.fn("IntegrationProxy.learnFromService")(function* (
    name: string,
    url: string,
    service: string,
    request: ProxyRequest,
  ) {
    const running = learning.get(name);
    if (running !== undefined) return yield* Deferred.await(running);
    const done = Deferred.makeUnsafe<void>();
    learning.set(name, done);
    yield* forward(
      name,
      url,
      service,
      { ...request, body: LEARN_TOOLS_BODY },
      { id: "t3-learn-tools", method: "tools/list" },
      true,
    ).pipe(
      // Reading the body to its end is what feeds `learn`.
      Effect.flatMap(({ response }) =>
        Effect.promise(() => response.arrayBuffer().catch(() => undefined)),
      ),
      Effect.ensuring(
        Effect.suspend(() => {
          learning.delete(name);
          return Deferred.succeed(done, undefined);
        }),
      ),
    );
  });

  const gateToolCall = Effect.fn("IntegrationProxy.gateToolCall")(function* (input: {
    readonly assistant: Assistant | undefined;
    readonly threadId: ThreadId;
    readonly name: string;
    readonly service: string;
    readonly readOnlyTools: ReadonlyArray<string> | undefined;
    readonly message: JsonRpcMessage;
    readonly url: string;
    readonly request: ProxyRequest;
  }) {
    const tool = typeof input.message.params?.name === "string" ? input.message.params.name : "";
    const mattersHere = decideToolCall(input.assistant, true) !== "forward";
    if (
      mattersHere &&
      !annotations.has(input.name) &&
      input.readOnlyTools?.includes(tool) !== true
    ) {
      yield* learnFromService(input.name, input.url, input.service, input.request);
    }
    const write = isWriteTool(tool, annotations.get(input.name), input.readOnlyTools);
    const decision = decideToolCall(input.assistant, write);
    if (decision === "forward" || input.assistant === undefined) {
      return { allowed: true as const, release: Effect.void };
    }
    if (decision === "block") {
      return { allowed: false as const, message: readOnlyBlocked(input.service, tool) };
    }
    const args = input.message.params?.arguments ?? {};
    return yield* gate.requestToolApproval({
      assistant: input.assistant,
      threadId: input.threadId,
      integration: input.name,
      serviceName: input.service,
      tool,
      argsHash: argumentsHash(args),
      argsPreview: Array.from(JSON.stringify(args, null, 2))
        .slice(0, ARGS_PREVIEW_CHARS)
        .join(""),
    });
  });

  const handle = Effect.fn("IntegrationProxy.handle")(function* (request: ProxyRequest) {
    const invocation = yield* registry.resolve(request.token);
    // The registry holds provider session tokens only: outside OAuth clients never get here.
    if (invocation === undefined) {
      return jsonResponse({ error: "invalid_mcp_credential" }, 401);
    }
    const threadId = invocation.thread.threadId;
    const notFound = jsonResponse({ error: "not_found" }, 404);
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    const server = Option.getOrUndefined(settings)?.mcpServers[request.name];
    if (server?.transport !== "http" || server.integration === undefined) return notFound;
    const assistant = Option.getOrUndefined(yield* directory.forThread(threadId))?.assistant;
    if (!t3ServerAllowed(request.name, server, assistant)) return notFound;
    const entry = auth.catalog.find((candidate) => candidate.id === server.integration?.catalogId);
    const service = entry?.name ?? request.name;

    if (request.method !== "POST") {
      return (yield* forward(request.name, server.url, service, request, undefined, false))
        .response;
    }
    const body = parseJson(request.body);
    if (Option.isNone(body)) {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    const parsed = body.value;
    if (Array.isArray(parsed)) {
      const calls = parsed.map(asMessage).filter((m) => m?.method === "tools/call");
      // A batch would carry calls past the gate; assistants send them one at a time.
      if (assistant !== undefined && calls.length > 0) {
        return jsonResponse(
          parsed
            .map(asMessage)
            .filter((m) => m?.id !== undefined)
            .map((m) => toolError(m?.id, BATCHED_TOOL_CALLS)),
        );
      }
      return (yield* forward(request.name, server.url, service, request, undefined, false))
        .response;
    }
    const message = asMessage(parsed);
    if (message?.method !== "tools/call") {
      return (yield* forward(
        request.name,
        server.url,
        service,
        request,
        message,
        message?.method === "tools/list",
      )).response;
    }
    const approval = yield* gateToolCall({
      assistant,
      threadId,
      name: request.name,
      service,
      readOnlyTools: entry?.readOnlyTools,
      message,
      url: server.url,
      request,
    });
    if (!approval.allowed) return jsonResponse(toolError(message.id, approval.message));
    const outcome = yield* forward(request.name, server.url, service, request, message, false);
    // The service did not act, so the approval still stands for the retry.
    if (!outcome.acted) yield* approval.release;
    return outcome.response;
  });

  return IntegrationProxy.of({ handle });
});

export const layer = Layer.effect(IntegrationProxy, make);

/** `/mcp/integrations/<name>` on T3's HTTP server, beside `/mcp`. */
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const proxy = yield* IntegrationProxy;
    yield* router.add(
      "*",
      `${INTEGRATIONS_PROXY_PATH_PREFIX}/:name`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { name } = yield* HttpRouter.params;
        const body =
          request.method === "POST"
            ? new Uint8Array(
                yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))),
              )
            : undefined;
        const response = yield* proxy.handle({
          name: name ?? "",
          token: parseBearerToken(request) ?? "",
          method: request.method,
          headers: request.headers,
          body,
        });
        return HttpServerResponse.fromWeb(response);
      }),
    );
  }),
);
