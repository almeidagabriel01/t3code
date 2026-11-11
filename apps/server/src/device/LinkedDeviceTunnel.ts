import { DeviceError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { requestUrl } from "../requestUrl.ts";
import { proxyHttp } from "./DeviceHubProxy.ts";
import * as DeviceService from "./DeviceService.ts";
import { agentRpcError } from "./LinkedDeviceGateway.ts";
import { LINKED_DEVICE_AGENT_ROUTE_PREFIX } from "./LinkedDeviceHost.ts";

const isDeviceError = Schema.is(DeviceError);

// agent-device's CLI prints a `/rpc` answer's error whatever the status, so the agent reads it.
const refuse = (request: HttpServerRequest.HttpServerRequest, message: string, status: number) =>
  request.url.split("?")[0]!.endsWith("/rpc")
    ? HttpServerResponse.text(agentRpcError(message), { contentType: "application/json" })
    : HttpServerResponse.jsonUnsafe({ message }, { status });

/**
 * Where a local launcher's agent-device CLI reaches a linked device: `<prefix>/<hostId>/<token>`
 * stands in for a daemon's base URL, and each call goes on to the linked environment, which
 * checks it against that environment's own access, holds and sessions before its daemon sees it.
 */
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const [hostId = "", token = "", ...rest] = url.value.pathname
    .slice(LINKED_DEVICE_AGENT_ROUTE_PREFIX.length + 1)
    .split("/");
  const path = `/${rest.join("/")}`;
  const bearer = request.headers.authorization ?? "";
  if (token === "" || bearer !== `Bearer ${token}`)
    return refuse(
      request,
      "Call device_open again and run the agent-device command it returns.",
      401,
    );
  const devices = yield* DeviceService.DeviceService;
  const upstream = yield* devices.linkedAgentUpstream(decodeURIComponent(hostId), token, path);
  if (Option.isNone(upstream))
    return refuse(
      request,
      "This device's connection here ended. Call device_open again and run the command it returns.",
      410,
    );
  return yield* proxyHttp(
    request,
    `${upstream.value.url}${url.value.search}`,
    upstream.value.headers,
  );
}).pipe(
  Effect.catch((error) =>
    HttpServerRequest.HttpServerRequest.useSync((request) =>
      refuse(
        request,
        isDeviceError(error)
          ? error.message
          : "The linked environment stopped answering. Check the link in Settings → Connections, and do not retry in a loop.",
        502,
      ),
    ),
  ),
);

export const layer = HttpRouter.add("*", `${LINKED_DEVICE_AGENT_ROUTE_PREFIX}/*`, handler);
