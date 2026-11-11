import {
  DeviceError,
  type DeviceId,
  DeviceNotFoundError,
  LINKED_DEVICE_ROUTE_PREFIX,
  LINKED_DEVICE_THREAD_HEADER,
  LinkedDeviceCloseInput,
  LinkedDeviceHoldInput,
  LinkedDeviceListResult,
  LinkedDeviceOpenInput,
  LinkedDeviceOpenResult,
  LinkedDeviceRefusal,
  LinkedDeviceScreenshotInput,
  type LinkedDeviceThread,
  LOCAL_DEVICE_HOST_ID,
  type ThreadId,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AGENT_DEVICE_READ_ONLY_COMMANDS } from "./AgentDeviceShim.ts";
import { proxyHubRequest } from "./DeviceHubProxy.ts";
import * as DeviceService from "./DeviceService.ts";
import { AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";

/** A call this environment refuses a link, answered as JSON the linking side reads. */
export class LinkedDeviceRefused extends Schema.TaggedError<LinkedDeviceRefused>()(
  "LinkedDeviceRefused",
  { status: Schema.Number, refusal: LinkedDeviceRefusal },
) {}

const refused = (status: number, refusal: LinkedDeviceRefusal) =>
  new LinkedDeviceRefused({ status, refusal });

const NO_STORE = { "cache-control": "no-store" };
const MAX_JSON_BYTES = 256 * 1024;
const MAX_RPC_BYTES = 4 * 1024 * 1024;
/**
 * T3 Connect drops a request idle for about 100 s, and an agent-device command can run for
 * minutes (the first iOS command builds a test runner). JSON allows leading whitespace, so a
 * forwarded `/rpc` answer starts with a space this often until the daemon answers.
 */
export const RPC_KEEPALIVE = "25 seconds";

/** agent-device's daemon routes a forwarded CLI may reach, with the methods each takes. */
const AGENT_ROUTES: ReadonlyArray<{ readonly path: RegExp; readonly method: string }> = [
  { path: /^\/rpc$/, method: "POST" },
  { path: /^\/health$/, method: "GET" },
  // Not `/upload/preflight`: its answer carries the daemon's token. Refused, the CLI uploads here.
  { path: /^\/upload$/, method: "POST" },
  { path: /^\/artifacts(\/[A-Za-z0-9._~%-]+)*\/?$/, method: "GET" },
  { path: /^\/sessions\/[^/]+\/requests\/[^/]+\/diagnostics$/, method: "GET" },
];

/** Device selectors a forwarded command may carry; each must name the device the thread opened. */
const DEVICE_SELECTOR_FLAGS = ["udid", "serial", "device"];

const decodeOpen = Schema.decodeUnknownEffect(LinkedDeviceOpenInput);
const decodeClose = Schema.decodeUnknownEffect(LinkedDeviceCloseInput);
const decodeHold = Schema.decodeUnknownEffect(LinkedDeviceHoldInput);
const decodeScreenshot = Schema.decodeUnknownEffect(LinkedDeviceScreenshotInput);
const encodeList = Schema.encodeEffect(Schema.toCodecJson(LinkedDeviceListResult));
const encodeOpen = Schema.encodeEffect(Schema.toCodecJson(LinkedDeviceOpenResult));
const encodeDeviceError = Schema.encodeEffect(Schema.toCodecJson(DeviceError));

const badRequest = refused(400, { state: "connected", message: "The request was not valid." });

const readJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_JSON_BYTES)),
    Effect.mapError(() => badRequest),
  );
});

/**
 * The link calling, checked the way `/mcp` checks it and then for devices: a peer link's own
 * session, the beta on, paired above read-only, not blocked here, and device support on.
 */
const authenticateLink = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateMcpClient(request).pipe(
    Effect.mapError(() =>
      refused(401, {
        state: "link_down",
        message:
          "This environment no longer accepts the link. It may have been revoked here; link it again.",
      }),
    ),
  );
  if (!session.peerLink)
    return yield* refused(403, {
      state: "not_allowed",
      message: "Only a linked T3 Code environment can use devices here.",
    });
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(() =>
      refused(503, { state: "link_down", message: "The settings here could not be read." }),
    ),
  );
  if (!settings.linkedEnvironmentsEnabled)
    return yield* refused(403, {
      state: "linked_environments_off",
      message:
        "This environment has Linked environments turned off. Its owner can turn it on in Settings → Labs.",
    });
  if (session.access === "read-only")
    return yield* refused(403, {
      state: "not_allowed",
      message:
        "This link was paired read-only, and devices need a link that can operate. Link again with more access.",
    });
  if (settings.deviceBlockedLinks.some((entry) => entry.linkId === session.sessionId))
    return yield* refused(403, {
      state: "not_allowed",
      message:
        "The owner of this environment blocked this link from using devices. They can allow it again in Settings → Devices.",
    });
  if (!settings.enableDeviceSupport)
    return yield* refused(409, {
      state: "devices_off",
      message:
        "Devices are turned off on this environment. Its owner can turn on Use devices in Settings → Devices.",
    });
  const link = { linkId: session.sessionId, label: session.label };
  yield* (yield* DeviceService.DeviceService).noteLinkClient(link);
  return link;
});

type Link = Effect.Success<typeof authenticateLink>;

/** A linked thread as this environment names it, with its ancestors named the same way. */
const linkedCaller = (link: Link, thread: LinkedDeviceThread) => ({
  threadId: DeviceService.linkedThreadId(link, thread.id),
  agent: {
    link,
    ...(thread.title === undefined ? {} : { threadTitle: thread.title }),
    ancestors: (thread.ancestors ?? []).map((id) => DeviceService.linkedThreadId(link, id)),
  } satisfies DeviceService.DeviceAgentCaller,
});

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

/** Device errors travel encoded, so the linking side's agent hears this side's own reason. */
const deviceErrorResponse = (error: DeviceError) =>
  encodeDeviceError(error).pipe(
    Effect.map((encoded) => json({ error: encoded }, 409)),
    Effect.orElseSucceed(() => json({ error: null, message: error.message }, 409)),
  );

const isDeviceError = Schema.is(DeviceError);
const isRefused = Schema.is(LinkedDeviceRefused);

const respond = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  effect.pipe(
    Effect.catch((error: E) => {
      if (isRefused(error)) return Effect.succeed(json(error.refusal, error.status));
      if (isDeviceError(error)) return deviceErrorResponse(error);
      return Effect.logWarning("Linked device request failed", { error }).pipe(
        Effect.as(json({ state: "connected", message: "The device request failed here." }, 500)),
      );
    }),
  );

/**
 * A JSON-RPC error agent-device's CLI prints as the command's failure. It reads any `/rpc`
 * answer's body whatever its status, so refusals there take this shape to reach the agent.
 */
export const agentRpcError = (message: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message, data: { code: "COMMAND_FAILED", message } },
  });

/** `respond` for agent-device routes: refusals of a `/rpc` call answer as JSON-RPC errors. */
const respondAgent = Effect.fn("LinkedDeviceGateway.respondAgent")(function* <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!request.url.split("?")[0]!.endsWith("/rpc")) return yield* respond(effect);
  return yield* effect.pipe(
    Effect.catch((error: E) =>
      (isRefused(error) || isDeviceError(error)
        ? Effect.succeed(isRefused(error) ? error.refusal.message : error.message)
        : Effect.logWarning("Linked device request failed", { error }).pipe(
            Effect.as("The device request failed on the linked environment."),
          )
      ).pipe(
        Effect.map((message) =>
          HttpServerResponse.text(agentRpcError(message), {
            contentType: "application/json",
            headers: NO_STORE,
          }),
        ),
      ),
    ),
  );
});

const hostId = LOCAL_DEVICE_HOST_ID;

const listRoute = HttpRouter.add(
  "POST",
  `${LINKED_DEVICE_ROUTE_PREFIX}/list`,
  respond(
    Effect.gen(function* () {
      const link = yield* authenticateLink;
      const devices = yield* DeviceService.DeviceService;
      // Only this machine's own devices: SSH, cloud and leased hosts, and other links, stay here.
      const state = yield* devices.list;
      const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
      const holds = yield* Effect.forEach(
        (state.holds ?? []).filter((hold) => hold.hostId === hostId),
        (hold) =>
          devices.holdLink(hostId, hold.deviceId).pipe(
            Effect.map((holder) => ({
              deviceId: hold.deviceId,
              since: hold.since,
              owner:
                holder === undefined
                  ? ("owner" as const)
                  : holder === link.linkId
                    ? ("you" as const)
                    : ("other_link" as const),
              ...(hold.linked && holder !== link.linkId ? { label: hold.linked.label } : {}),
            })),
          ),
      );
      return json(
        yield* encodeList({
          environmentLabel: descriptor.label,
          platforms: state.hosts.find((host) => host.id === hostId)?.platforms ?? [],
          agentAccessEnabled: state.agentAccessEnabled,
          agentDeviceVersion: AGENT_DEVICE_VERSION,
          devices: state.devices.filter((device) => device.hostId === hostId),
          holds,
        }),
      );
    }),
  ),
);

/** Agent bindings this side made for linked threads, by thread (which names its link) and device. */
const bindingKey = (threadId: string, deviceId: string) => `${threadId}\u0000${deviceId}`;

const make = Effect.sync(() => {
  const bindings = new Map<
    string,
    {
      readonly threadId: string;
      readonly deviceId: string;
      readonly session: string;
      readonly agentDeviceId: string;
      readonly baseUrl: string;
      readonly token: string;
    }
  >();

  const openRoute = HttpRouter.add(
    "POST",
    `${LINKED_DEVICE_ROUTE_PREFIX}/open`,
    respond(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const input = yield* readJson.pipe(
          Effect.flatMap(decodeOpen),
          Effect.mapError(() => badRequest),
        );
        const devices = yield* DeviceService.DeviceService;
        const caller = linkedCaller(link, input.thread);
        const target = { threadId: caller.threadId, hostId, deviceId: input.deviceId };
        // A person watching or driving by hand is still checked against the device's policy,
        // so an existing link never gains a view of a device its owner closed to agents.
        if (!input.agent)
          yield* devices.authorizeAgent({ ...target, intent: "read", agent: caller.agent });
        const session = yield* devices.open(
          {
            threadId: caller.threadId,
            hostId,
            deviceId: input.deviceId,
            platform: input.platform,
            ...(input.boot === undefined ? {} : { boot: input.boot }),
          },
          {
            ...(input.agent ? { agent: caller.agent } : {}),
            link: { ...link, threadTitle: input.thread.title },
          },
        );
        let agentDeviceId: string | null = null;
        if (input.agent) {
          const bound = yield* devices.bindLinkedAgent({
            threadId: caller.threadId,
            hostId,
            deviceId: session.deviceId,
            agent: caller.agent,
          });
          bindings.set(bindingKey(caller.threadId, session.deviceId), {
            threadId: caller.threadId,
            deviceId: session.deviceId,
            session: bound.session,
            agentDeviceId: bound.agentDeviceId,
            ...bound.daemon,
          });
          agentDeviceId = bound.agentDeviceId;
        }
        const state = yield* devices.state;
        const device = state.devices.find(
          (candidate) => candidate.hostId === hostId && candidate.id === session.deviceId,
        );
        if (!device) return yield* new DeviceNotFoundError({ hostId, deviceId: session.deviceId });
        return json(yield* encodeOpen({ device, agentDeviceId }));
      }),
    ),
  );

  const closeRoute = HttpRouter.add(
    "POST",
    `${LINKED_DEVICE_ROUTE_PREFIX}/close`,
    respond(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const input = yield* readJson.pipe(
          Effect.flatMap(decodeClose),
          Effect.mapError(() => badRequest),
        );
        const threadId = DeviceService.linkedThreadId(link, input.threadId);
        yield* (yield* DeviceService.DeviceService).close({
          threadId,
          hostId,
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
          ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
        });
        for (const [key, binding] of bindings) {
          if (
            binding.threadId === threadId &&
            (input.deviceId === undefined || binding.deviceId === input.deviceId)
          )
            bindings.delete(key);
        }
        return json({});
      }),
    ),
  );

  const holdRoute = HttpRouter.add(
    "POST",
    `${LINKED_DEVICE_ROUTE_PREFIX}/hold`,
    respond(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const input = yield* readJson.pipe(
          Effect.flatMap(decodeHold),
          Effect.mapError(() => badRequest),
        );
        yield* (yield* DeviceService.DeviceService).setLinkedHold({ ...input, hostId, link });
        return json({});
      }),
    ),
  );

  const screenshotRoute = HttpRouter.add(
    "POST",
    `${LINKED_DEVICE_ROUTE_PREFIX}/screenshot`,
    respond(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const input = yield* readJson.pipe(
          Effect.flatMap(decodeScreenshot),
          Effect.mapError(() => badRequest),
        );
        const devices = yield* DeviceService.DeviceService;
        const caller = linkedCaller(link, input.thread);
        yield* devices.authorizeAgent({
          threadId: caller.threadId,
          hostId,
          deviceId: input.deviceId,
          intent: "read",
          agent: caller.agent,
        });
        const shot = yield* devices.screenshot({ hostId, deviceId: input.deviceId });
        return HttpServerResponse.uint8Array(shot.png, {
          contentType: "image/png",
          headers: NO_STORE,
        });
      }),
    ),
  );

  const agentRoute = HttpRouter.add(
    "*",
    `${LINKED_DEVICE_ROUTE_PREFIX}/agent/*`,
    respondAgent(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) return yield* badRequest;
        const [encodedDevice, ...rest] = url.value.pathname
          .slice(`${LINKED_DEVICE_ROUTE_PREFIX}/agent/`.length)
          .split("/");
        const deviceId = decodeURIComponent(encodedDevice ?? "") as DeviceId;
        const path = `/${rest.join("/")}`;
        if (!AGENT_ROUTES.some((route) => route.path.test(path) && route.method === request.method))
          return json({ state: "connected", message: "Not found." }, 404);
        const remoteThread = request.headers[LINKED_DEVICE_THREAD_HEADER];
        if (!remoteThread || !deviceId) return yield* badRequest;
        const threadId = DeviceService.linkedThreadId(link, remoteThread) as ThreadId;
        const binding = bindings.get(bindingKey(threadId, deviceId));
        const devices = yield* DeviceService.DeviceService;
        const open = (yield* devices.sessionsForThread(threadId)).some(
          (session) => session.hostId === hostId && session.deviceId === deviceId,
        );
        if (!binding || !open)
          return yield* refused(409, {
            state: "connected",
            message: "This thread has no open session on that device. Call device_open again.",
          });
        if (path !== "/rpc") {
          yield* devices.authorizeAgent({
            threadId,
            hostId,
            deviceId,
            intent: "read",
            agent: { link },
          });
          return yield* forward(request, binding, path, url.value.search, undefined, true);
        }
        const body = yield* request.text.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_RPC_BYTES)),
          Effect.mapError(() => badRequest),
        );
        const rewritten = rewriteRpc(body, binding);
        if (rewritten._tag === "Refused")
          return yield* refused(400, { state: "connected", message: rewritten.message });
        yield* devices.authorizeAgent({
          threadId,
          hostId,
          deviceId,
          intent: AGENT_DEVICE_READ_ONLY_COMMANDS.includes(rewritten.command) ? "read" : "open",
          agent: { link },
        });
        return yield* forward(request, binding, path, "", rewritten.body, rewritten.streams);
      }),
    ),
  );

  const hubRoute = HttpRouter.add(
    "*",
    `${LINKED_DEVICE_ROUTE_PREFIX}/hub/*`,
    respond(
      Effect.gen(function* () {
        const link = yield* authenticateLink;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) return yield* badRequest;
        const hubPath = url.value.pathname.slice(`${LINKED_DEVICE_ROUTE_PREFIX}/hub`.length) || "/";
        const devices = yield* DeviceService.DeviceService;
        const prefix = DeviceService.linkedThreadId(link, "");
        const linkSessions = (yield* devices.state).sessions.filter(
          (session) => session.hostId === hostId && session.threadId.startsWith(prefix),
        );
        const named = hubDeviceId(hubPath, url.value.searchParams);
        return yield* proxyHubRequest({
          request,
          url: url.value,
          hubPath,
          hostId,
          // A link watches only a device it opened here, and any listing once it has one open.
          authorize: () =>
            (
              named === undefined
                ? linkSessions.length > 0
                : linkSessions.some((session) => session.deviceId === named)
            )
              ? Effect.void
              : Effect.fail(
                  refused(403, {
                    state: "connected",
                    message: "Open the device before watching it.",
                  }),
                ),
          onUserInput: (deviceId) => devices.holdOnInput(hostId, deviceId as DeviceId, link),
        });
      }),
    ),
  );

  return Layer.mergeAll(
    listRoute,
    openRoute,
    closeRoute,
    holdRoute,
    screenshotRoute,
    agentRoute,
    hubRoute,
  );
});

/** The device a hub request names, in a serve-sim helper path or a `device` parameter. */
export const hubDeviceId = (hubPath: string, search: URLSearchParams) =>
  /^\/vendor\/serve-sim\/helper\/([^/]+)\//.exec(hubPath)?.[1] ??
  search.get("device") ??
  search.get("udid") ??
  search.get("serial") ??
  undefined;

/**
 * A forwarded `/rpc` body, default-deny: one `agent_device.command` whose session this side
 * names and whose device selectors, if any, name the device the thread opened.
 */
export const rewriteRpc = (
  body: string,
  binding: { readonly session: string; readonly agentDeviceId: string },
):
  | {
      readonly _tag: "Forward";
      readonly body: string;
      readonly command: string;
      /** The CLI asked for progress lines, which keep the request alive on their own. */
      readonly streams: boolean;
    }
  | { readonly _tag: "Refused"; readonly message: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { _tag: "Refused", message: "The agent-device request was not JSON." };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { method?: unknown }).method !== "agent_device.command"
  )
    return { _tag: "Refused", message: "Only agent-device commands reach a linked device." };
  const params = (parsed as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return { _tag: "Refused", message: "The agent-device command had no parameters." };
  const { command, flags } = params as { command?: unknown; flags?: unknown };
  if (typeof command !== "string" || command === "")
    return { _tag: "Refused", message: "The agent-device command had no name." };
  if (flags !== undefined && (typeof flags !== "object" || flags === null || Array.isArray(flags)))
    return { _tag: "Refused", message: "The agent-device command's flags were not valid." };
  for (const flag of DEVICE_SELECTOR_FLAGS) {
    const value = (flags as Record<string, unknown> | undefined)?.[flag];
    if (value !== undefined && value !== binding.agentDeviceId)
      return {
        _tag: "Refused",
        message:
          "That command names another device. A linked thread drives only the device it opened.",
      };
  }
  const progress = (params as { meta?: { requestProgress?: unknown } }).meta?.requestProgress;
  return {
    _tag: "Forward",
    command,
    streams: progress === "command" || progress === "replay-test",
    body: JSON.stringify({ ...parsed, params: { ...params, session: binding.session } }),
  };
};

const FORWARDED_AGENT_HEADERS = ["content-type", "accept", "x-request-id", "content-length"];

const forward = Effect.fn("LinkedDeviceGateway.forward")(function* (
  request: HttpServerRequest.HttpServerRequest,
  binding: { readonly baseUrl: string; readonly token: string },
  path: string,
  search: string,
  body: string | undefined,
  streams: boolean,
) {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_AGENT_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined && !(body !== undefined && name === "content-length"))
      headers[name] = value;
  }
  const upstream = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
    `${binding.baseUrl}${path}${search}`,
  ).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bearerToken(binding.token),
    body !== undefined
      ? HttpClientRequest.bodyText(body, "application/json")
      : request.method === "POST"
        ? HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          })
        : (self) => self,
  );
  if (streams) {
    const response = yield* http.execute(upstream);
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers: {
        ...NO_STORE,
        ...(response.headers["content-type"]
          ? { "content-type": response.headers["content-type"] }
          : {}),
      },
    });
  }
  // The answer is small; the wait for it is what can be long.
  const answer = http.execute(upstream).pipe(
    Effect.flatMap((response) => response.text),
    Effect.scoped,
    Effect.orElseSucceed(() =>
      agentRpcError("The device's agent-device daemon stopped answering."),
    ),
  );
  return HttpServerResponse.stream(keepAlive(answer).pipe(Stream.encodeText), {
    status: 200,
    contentType: "application/json",
    headers: NO_STORE,
  });
});

/** Spaces every `RPC_KEEPALIVE` until `answer` arrives, then the answer. */
export const keepAlive = <E, R>(answer: Effect.Effect<string, E, R>) =>
  Stream.merge(
    Stream.tick(RPC_KEEPALIVE).pipe(Stream.drop(1), Stream.as(" ")),
    Stream.fromEffect(answer),
    { haltStrategy: "right" },
  );

export const layer = Layer.unwrap(make);
