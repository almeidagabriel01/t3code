import {
  DeviceError,
  DeviceHostUnavailableError,
  type DeviceHostSummary,
  DeviceOperationError,
  type DevicePlatformAvailability,
  type EnvironmentId,
  LINKED_DEVICE_ROUTE_PREFIX,
  LINKED_DEVICE_THREAD_HEADER,
  type LinkedDeviceHold,
  LinkedDeviceListResult,
  LinkedDeviceOpenResult,
  LinkedDeviceRefusal,
  type LinkedDeviceState,
  linkedDeviceHostId,
  type PeerLinkError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import type { ResolvedPeerLink } from "../peer/PeerLinks.ts";
import type * as DeviceHost from "./DeviceHost.ts";
import { AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";

/** Where this server forwards a local launcher's agent-device calls to a linked device. */
export const LINKED_DEVICE_AGENT_ROUTE_PREFIX = "/api/linked-device-agent";

/** How long a resolved address and token are reused before the link is resolved again. */
const RESOLVE_TTL_MS = 60_000;

/** What a linked host needs from the link it is reached through. */
export interface LinkedDeviceHostLink {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** An address that answers as the linked environment, with the link's token. */
  readonly resolve: Effect.Effect<Pick<ResolvedPeerLink, "url" | "token">, PeerLinkError>;
  readonly recordOutcome: (outcome: { readonly error: string | null }) => Effect.Effect<void>;
}

/** A hold the linked environment reports, as this side shows it. */
export interface LinkedHostHold {
  readonly deviceId: string;
  readonly since: string;
  /** Set when someone other than this environment's user holds it. */
  readonly linked?: { readonly label: string };
}

const decodeList = Schema.decodeUnknownEffect(Schema.toCodecJson(LinkedDeviceListResult));
const decodeOpen = Schema.decodeUnknownEffect(Schema.toCodecJson(LinkedDeviceOpenResult));
const decodeRefusal = Schema.decodeUnknownOption(LinkedDeviceRefusal);
const decodeDeviceError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.toCodecJson(DeviceError) }),
);

/**
 * The devices of a linked environment's own machine, as one host here. It runs nothing on this
 * machine: every call goes over the link to that environment, which checks its own access
 * policy, holds and in-use rule, and streams and agent-device calls are routed to it.
 */
export const make = Effect.fn("LinkedDeviceHost.make")(function* (input: {
  readonly link: LinkedDeviceHostLink;
  /** This server's own loopback origin, which local launchers reach the tunnel at. */
  readonly localOrigin: string;
}) {
  const http = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const hostId = linkedDeviceHostId(input.link.environmentId);
  let label = input.link.label;
  let linkState: LinkedDeviceState = "connected";
  let linkDetail: string | undefined;
  let platforms: ReadonlyArray<DevicePlatformAvailability> = [];
  let versionMismatch: string | undefined;
  let holds: ReadonlyArray<LinkedHostHold> = [];
  let resolved: { readonly at: number; readonly link: { url: string; token: string } } | undefined;
  /** The id agent-device selects each device by there, as its last open reported it. */
  const agentDeviceIds = new Map<string, string>();
  /** Launcher tokens here, each bound to one device and the thread whose session it drives. */
  const tunnels = new Map<string, { readonly deviceId: string; readonly threadId: string }>();

  const unavailable = (state: LinkedDeviceState, reason: string) =>
    Effect.sync(() => {
      linkState = state;
      linkDetail = reason;
    }).pipe(
      Effect.andThen(
        Effect.fail(new DeviceHostUnavailableError({ hostId, hostLabel: label, reason })),
      ),
    );

  const resolve = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (resolved && now - resolved.at < RESOLVE_TTL_MS) return resolved.link;
    const link = yield* input.link.resolve.pipe(
      Effect.catch((error) =>
        unavailable(
          error.reason === "unreachable" ? "link_down" : "not_allowed",
          `${label} is not reachable over the link: ${error.message}`,
        ),
      ),
    );
    resolved = { at: now, link: { url: link.url, token: link.token } };
    return resolved.link;
  });

  /** One call to the linked environment's device routes, read back the way it answered. */
  const call = Effect.fn("LinkedDeviceHost.call")(function* (path: string, body: unknown) {
    const link = yield* resolve;
    const response = yield* http
      .execute(
        HttpClientRequest.post(`${link.url}${LINKED_DEVICE_ROUTE_PREFIX}${path}`).pipe(
          HttpClientRequest.bearerToken(link.token),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            resolved = undefined;
          }).pipe(
            Effect.andThen(input.link.recordOutcome({ error: String(cause) })),
            Effect.andThen(unavailable("link_down", `${label} stopped answering over the link.`)),
          ),
        ),
      );
    return yield* readResponse(response);
  });

  const readResponse = Effect.fn("LinkedDeviceHost.readResponse")(function* (
    response: HttpClientResponse.HttpClientResponse,
  ) {
    if (response.status === 200) {
      linkState = versionMismatch ? "needs_update" : "connected";
      linkDetail = versionMismatch;
      yield* input.link.recordOutcome({ error: null });
      return response;
    }
    // An older server has no device routes; the link works, the feature does not yet.
    if (response.status === 404)
      return yield* unavailable(
        "needs_update",
        `${label} runs a T3 Code version without linked devices. Update it to use its devices here.`,
      );
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    const deviceError = decodeDeviceError(body);
    if (Option.isSome(deviceError)) return yield* deviceError.value.error;
    const refusal = decodeRefusal(body);
    if (Option.isSome(refusal)) {
      if (response.status === 401) resolved = undefined;
      return yield* unavailable(refusal.value.state, refusal.value.message);
    }
    return yield* new DeviceOperationError({
      operation: "reach linked device",
      reason: "request_failed",
      cause: new Error(`HTTP ${response.status}`),
    });
  });

  const json = <A>(
    response: HttpClientResponse.HttpClientResponse,
    decode: (value: unknown) => Effect.Effect<A, unknown>,
  ) =>
    response.json.pipe(
      Effect.flatMap(decode),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation: "read linked device",
            reason: "invalid_payload",
            cause,
          }),
      ),
    );

  const openThere = Effect.fn("LinkedDeviceHost.open")(function* (
    device: DeviceHost.HostDevice,
    context: DeviceHost.DeviceOpenContext | undefined,
    boot: boolean,
  ) {
    const thread = context?.thread;
    if (!thread)
      return yield* new DeviceOperationError({
        operation: "open linked device",
        reason: "invalid_payload",
        cause: new Error("No thread to open the device for."),
      });
    const opened = yield* json(
      yield* call("/open", {
        thread: {
          id: thread.threadId,
          ...(thread.title === undefined ? {} : { title: thread.title }),
          ...(thread.ancestors === undefined ? {} : { ancestors: thread.ancestors }),
        },
        deviceId: device.id,
        platform: device.platform,
        boot,
        agent: thread.agent,
      }),
      decodeOpen,
    );
    if (opened.agentDeviceId !== null) agentDeviceIds.set(opened.device.id, opened.agentDeviceId);
    return opened.device.id;
  });

  const operations: DeviceHost.DeviceOperations = {
    list: Effect.gen(function* () {
      const listed = yield* json(yield* call("/list", {}), decodeList);
      label = listed.environmentLabel;
      platforms = listed.platforms;
      versionMismatch =
        listed.agentDeviceVersion === AGENT_DEVICE_VERSION
          ? undefined
          : `${label} runs agent-device ${listed.agentDeviceVersion} and this environment ${AGENT_DEVICE_VERSION}. You can watch its devices; to let agents drive them, update both to the same T3 Code version.`;
      linkState = versionMismatch ? "needs_update" : "connected";
      linkDetail = versionMismatch;
      holds = listed.holds.map((hold: LinkedDeviceHold) => ({
        deviceId: hold.deviceId,
        since: hold.since,
        ...(hold.owner === "you" ? {} : { linked: { label: hold.label ?? label } }),
      }));
      return {
        devices: listed.devices.map(({ hostId: _hostId, ...device }) => device),
        detail: undefined,
      };
    }),
    boot: (device, context) => openThere(device, context, true),
    attach: (device, context) => openThere(device, context, false).pipe(Effect.asVoid),
    // Powering a device off happens there, through a close that asks for it.
    shutdown: () =>
      Effect.fail(
        new DeviceOperationError({
          operation: "shutdown",
          reason: "hub_rejected",
          cause: new Error("A linked environment's device powers off from that environment."),
        }),
      ),
    screenshot: Effect.fn("LinkedDeviceHost.screenshot")(function* (device, context) {
      const response = yield* call("/screenshot", {
        thread: { id: context?.thread?.threadId ?? "viewer" },
        deviceId: device.id,
      });
      return new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "screenshot",
                reason: "request_failed",
                cause,
              }),
          ),
        ),
      );
    }),
    agentEndpoint: Effect.fn("LinkedDeviceHost.agentEndpoint")(function* (deviceId, thread) {
      if (versionMismatch)
        return yield* new DeviceHostUnavailableError({
          hostId,
          hostLabel: label,
          reason: versionMismatch,
        });
      if (!thread)
        return yield* new DeviceHostUnavailableError({
          hostId,
          hostLabel: label,
          reason: "No thread to drive the device for.",
        });
      // One token per device: a new lineage's thread replaces the last one's, which the
      // in-use rule here and there has already ended.
      for (const [token, bound] of tunnels) if (bound.deviceId === deviceId) tunnels.delete(token);
      const token = Base64Url.encode(yield* random.randomBytes(32).pipe(Effect.orDie));
      tunnels.set(token, { deviceId, threadId: thread.threadId });
      return {
        baseUrl: `${input.localOrigin}${LINKED_DEVICE_AGENT_ROUTE_PREFIX}/${encodeURIComponent(hostId)}/${token}`,
        token,
        agentDeviceId: agentDeviceIds.get(deviceId) ?? deviceId,
      };
    }),
    closeSession: Effect.fn("LinkedDeviceHost.closeSession")(function* (session) {
      for (const [token, bound] of tunnels)
        if (bound.deviceId === session.deviceId && bound.threadId === session.threadId)
          tunnels.delete(token);
      yield* call("/close", session);
    }),
    setHold: (deviceId, held) => call("/hold", { deviceId, held }).pipe(Effect.asVoid),
    holds: Effect.sync(() => holds),
  };

  const ready: DeviceHost.DeviceHostAgentReady = {
    nodePath: "",
    // Never reached: `upstream` routes every hub request over the link.
    hub: { origin: "http://linked-device.invalid" },
    devices: operations,
    agentDevice: null,
    run: () =>
      Effect.succeed({
        stdout: "",
        stderr: `Device settings for ${label}'s devices are changed on ${label}.`,
        code: 127,
      }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    upstream: (hubPath, search) =>
      resolve.pipe(
        Effect.map((link) => ({
          url: `${link.url}${LINKED_DEVICE_ROUTE_PREFIX}/hub${hubPath}${search.size > 0 ? `?${search.toString()}` : ""}`,
          headers: { authorization: `Bearer ${link.token}` },
          protocols: [],
        })),
        Effect.orElseSucceed(() => null),
      ),
  };

  const summary = Effect.sync((): DeviceHostSummary => ({
    id: hostId,
    label,
    kind: "linked",
    environmentId: input.link.environmentId,
    linkState,
    ...(linkDetail === undefined ? {} : { linkDetail }),
    platforms,
    hubInstalled: true,
    agentDeviceInstalled: true,
  }));

  /**
   * The linked environment's agent route for a launcher token here, with the link's token and
   * the thread the launcher drives for; none for a token this host never issued.
   */
  const agentUpstream = Effect.fn("LinkedDeviceHost.agentUpstream")(function* (
    token: string,
    path: string,
  ) {
    const bound = tunnels.get(token);
    if (!bound) return Option.none<DeviceHost.HubUpstream>();
    const link = yield* resolve;
    return Option.some({
      url: `${link.url}${LINKED_DEVICE_ROUTE_PREFIX}/agent/${encodeURIComponent(bound.deviceId)}${path}`,
      headers: {
        authorization: `Bearer ${link.token}`,
        [LINKED_DEVICE_THREAD_HEADER]: bound.threadId,
      },
      protocols: [],
    });
  });

  const host: DeviceHost.DeviceHost["Service"] & {
    readonly agentUpstream: typeof agentUpstream;
  } = {
    id: hostId,
    get label() {
      return label;
    },
    summary,
    platformAvailability: (platform) =>
      Effect.sync(
        () =>
          platforms.find((entry) => entry.platform === platform) ?? {
            platform,
            available: true,
          },
      ),
    // Nothing runs here, so being ready costs no call; listing is where the link is asked.
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () => Effect.succeed(ready),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.sync(() => tunnels.clear()),
    agentUpstream,
  };
  return host;
});

export type LinkedDeviceHost = Effect.Success<ReturnType<typeof make>>;
