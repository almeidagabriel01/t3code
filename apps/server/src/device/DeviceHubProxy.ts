import { requestUrl } from "../requestUrl.ts";
// Loopback-only hubs expose shell execution or unauthenticated actions.
// Proxy with environment read scope for streams and operate scope for input and tuning.
import { AuthOrchestrationReadScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DeviceService from "./DeviceService.ts";
import { repeatStillFrame } from "./mjpegStillFrame.ts";

const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices$/,
  /^\/vendor\/serve-sim\/api$/,
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  /^\/vendor\/serve-sim\/api\/event-log(\/events)?$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/panel\/(1|3)\/stream\.avcc$/,
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-sim\/appstate$/,
  /^\/vendor\/serve-emu\/api$/,
  /^\/vendor\/serve-emu\/api\/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$/,
  /^\/vendor\/serve-emu\/health$/,
];

// Paths that take methods besides GET; one missing from ALLOWED_PATHS takes no GET.
const MUTABLE_PATHS: ReadonlyArray<RegExp> = [
  /^\/vendor\/serve-sim\/api\/screenshot$/,
  // WebRTC signalling: opening and closing a view of the stream, so read scope.
  /^\/vendor\/serve-sim\/helper\/[^/]+\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/webrtc\/(offer|close)$/,
  /^\/vendor\/serve-emu\/api\/(screenshot|stream-mode|stream-settings)$/,
  /^\/vendor\/serve-emu\/api\/fold$/,
];

const ALLOWED_WS_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/devices\/ws$/,
  /^\/vendor\/serve-sim\/helper\/ws$/,
  /^\/vendor\/serve-emu\/ws$/,
];

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  // The client's HTTPS hop makes the hub reject our loopback Origin over T3 Connect.
  "x-forwarded-proto",
]);

// serve-sim's touch, button, key, orientation and hinge messages: a tag byte, then JSON.
const IOS_INPUT_TAGS = new Set([0x03, 0x04, 0x06, 0x07, 0x10]);

/**
 * Whether a frame the client sent is the user driving the device. serve-emu takes gestures as
 * JSON text; its only frame the viewer sends unprompted asks for a keyframe.
 */
export const isUserInputFrame = (frame: string | Uint8Array): boolean =>
  typeof frame === "string"
    ? !/"type"\s*:\s*"reset-video"/.test(frame)
    : IOS_INPUT_TAGS.has(frame[0] ?? -1);

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, origin: string) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  // serve-emu refuses mutations whose Origin differs from the request origin.
  if (request.headers.origin !== undefined) headers.origin = origin;
  return headers;
};

// Effect drops its listeners before closing a socket that is still connecting, and `ws` then
// emits an `error` nobody handles, which exits the server.
export const upstreamWebSocketConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor));

const proxyWebSocket = Effect.fn("DeviceHubProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  protocols: ReadonlyArray<string> = [],
  headers: Readonly<Record<string, string>> = {},
  onUserInput: Effect.Effect<void> = Effect.void,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    ...(protocols.length > 0 ? { protocols: [...protocols] } : {}),
    ...(Object.keys(headers).length > 0 ? { headers: { ...headers } } : {}),
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream, onUserInput),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames =
  /* Frame pumping runs continuously; a span per frame stream adds no diagnostic value. */
  Effect.fnUntraced(function* (
    source: Socket.Socket,
    sink: Socket.Writer,
    onUserInput?: Effect.Effect<void>,
  ) {
    const { pull } = yield* source.reader;
    while (true) {
      const frames = yield* pull;
      if (onUserInput && frames.some(isUserInputFrame)) yield* onUserInput;
      yield* sink.writeAll(frames);
    }
  });

export const proxyHttp = Effect.fn("DeviceHubProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  extraHeaders: Readonly<Record<string, string>> = {},
  /** Runs once the response body ends, however it ends. */
  release?: Effect.Effect<void>,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders({
      ...forwardHeaders(request, new URL(upstreamUrl).origin),
      ...extraHeaders,
    }),
    method === "GET" || method === "HEAD"
      ? (self) => self
      : // A bare stream body is sent as octet-stream; serve-sim refuses WebRTC
        // offers that are not application/json.
        HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    // A cookie from an upstream such as an EAS session's preview host would land on T3's origin.
    if (
      name === "content-encoding" ||
      name === "transfer-encoding" ||
      name === "connection" ||
      name === "set-cookie"
    ) {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  // Long-lived MJPEG and AVCC responses must not be buffered by compression.
  headers["cache-control"] = "no-store, no-transform";
  const stream = headers["content-type"]?.startsWith("multipart/x-mixed-replace")
    ? repeatStillFrame(response.stream)
    : response.stream;
  const body = release ? stream.pipe(Stream.ensuring(release)) : stream;
  return HttpServerResponse.stream(body, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

/** Whether a hub request takes input or changes the stream, rather than only watching. */
const hubRequestControlsDevice = (hubPath: string, method: string, upgrade: boolean) =>
  (upgrade && hubPath !== "/api/devices/ws") ||
  (method !== "GET" && method !== "HEAD" && /\/api\/(stream-(mode|settings)|fold)$/.test(hubPath));

/**
 * Proxies one allowlisted hub request to a host's hub. `authorize` runs once the route is known
 * to be allowed and is told whether it controls the device; `onUserInput` runs for input frames.
 */
export const proxyHubRequest = Effect.fn("DeviceHubProxy.proxyHubRequest")(function* <E, R>(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly hubPath: string;
  readonly hostId: string | undefined;
  readonly authorize: (controlsDevice: boolean) => Effect.Effect<void, E, R>;
  readonly onUserInput?: (deviceId: string) => Effect.Effect<void>;
}) {
  const { request, url, hubPath, hostId } = input;
  const upgrade = isWebSocketUpgrade(request);
  const matches = (paths: ReadonlyArray<RegExp>) => paths.some((pattern) => pattern.test(hubPath));
  const allowed = upgrade
    ? matches(ALLOWED_WS_PATHS)
    : matches(ALLOWED_PATHS) || matches(MUTABLE_PATHS);
  if (!allowed) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!upgrade && !matches(readOnly ? ALLOWED_PATHS : MUTABLE_PATHS)) {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const controlsDevice = hubRequestControlsDevice(hubPath, request.method, upgrade);
  yield* input.authorize(controlsDevice);
  const devices = yield* DeviceService.DeviceService;
  // Consume the auth ticket here; never forward it to the hub.
  const upstreamSearch = new URLSearchParams(url.search);
  upstreamSearch.delete("wsTicket");
  upstreamSearch.delete("hostId");
  // Physical iPhones and this computer stream from their own capture, with no hub behind them.
  const capture = upgrade ? null : yield* devices.captureRoute(hostId, hubPath, upstreamSearch);
  if (capture === "unavailable") {
    return HttpServerResponse.text("Device capture is not running", { status: 503 });
  }
  if (capture) {
    return yield* proxyHttp(request, capture.url, {}, capture.release).pipe(
      Effect.onError(() => capture.release),
    );
  }
  const ready = yield* devices.currentReadiness(hostId);
  if (!ready) {
    return HttpServerResponse.text("Device hub is not running", { status: 503 });
  }
  const search = upstreamSearch.size > 0 ? `?${upstreamSearch.toString()}` : "";
  // Hosts with several upstreams (one per cloud session) route and authenticate requests themselves.
  const routed = ready.upstream ? yield* ready.upstream(hubPath, upstreamSearch) : undefined;
  if (routed === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const upstreamUrl = routed?.url ?? `${ready.hub.origin}${hubPath}${search}`;
  if (upgrade) {
    // The user driving a device through the stream takes it over from the agent.
    const inputDevice = controlsDevice ? url.searchParams.get("device") : null;
    return yield* proxyWebSocket(
      request,
      upstreamUrl.replace(/^http/, "ws"),
      routed?.protocols,
      routed?.headers,
      inputDevice && input.onUserInput ? input.onUserInput(inputDevice) : undefined,
    );
  }
  return yield* proxyHttp(request, upstreamUrl, routed?.headers);
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const devices = yield* DeviceService.DeviceService;
  const hostId = url.value.searchParams.get("hostId") ?? undefined;
  return yield* proxyHubRequest({
    request,
    url: url.value,
    hubPath: url.value.pathname.slice(DeviceService.DEVICE_HUB_ROUTE_PREFIX.length) || "/",
    hostId,
    authorize: (controlsDevice) =>
      authenticateMediaRequest(
        controlsDevice ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      ),
    onUserInput: (deviceId) => devices.holdOnInput(hostId, deviceId),
  });
});

export const layer = HttpRouter.add("*", `${DeviceService.DEVICE_HUB_ROUTE_PREFIX}/*`, handler);
