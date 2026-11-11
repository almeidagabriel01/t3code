import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceHostUnavailableError,
  DeviceId,
  EnvironmentId,
  LINKED_DEVICE_ROUTE_PREFIX,
  LOCAL_DEVICE_HOST_ID,
  linkedDeviceHostId,
  PeerLinkError,
  type PeerLink,
  ThreadId,
  type DeviceServiceState,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  type HttpClientRequest,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import type { ResolvedPeerLink } from "../peer/PeerLinks.ts";
import * as ProcessRunner from "../processRunner.ts";
import { AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as LinkedDeviceGateway from "./LinkedDeviceGateway.ts";
import * as LinkedDeviceHost from "./LinkedDeviceHost.ts";
import * as LinkedDeviceTunnel from "./LinkedDeviceTunnel.ts";

const SIM = DeviceId.make("sim-1");
const PHONE = DeviceId.make("phone-1");
const PEER_ENV = EnvironmentId.make("env-studio");
const LINKED_HOST = linkedDeviceHostId(PEER_ENV);
const LINK_TOKEN = "link-token";
const OTHER_LINK_TOKEN = "other-link-token";

const settingsService = (settings: Ref.Ref<Settings>) =>
  ServerSettings.ServerSettingsService.of({
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    // Only flat device fields change in these tests.
    updateSettings: (patch) =>
      Ref.updateAndGet(settings, (current) => ({ ...current, ...patch }) as Settings),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });

/** The device owner's machine: one simulator and one physical phone, and an agent-device daemon. */
const peerHost = (): DeviceHost.DeviceHost["Service"] => {
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://hub.test" },
    devices: {
      list: Effect.succeed({
        devices: [
          {
            id: SIM,
            name: "iPhone 17",
            platform: "ios",
            version: "iOS 26",
            booted: true,
            physical: false,
          },
          {
            id: PHONE,
            name: "Pixel 10",
            platform: "android",
            version: "Android 16",
            booted: true,
            physical: true,
          },
        ],
        detail: undefined,
      }),
      boot: (device) => Effect.succeed(device.id),
      attach: () => Effect.void,
      shutdown: () => Effect.void,
      screenshot: () => Effect.succeed(new Uint8Array([137, 80, 78, 71])),
    },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  };
  return {
    id: LOCAL_DEVICE_HOST_ID,
    label: "This machine",
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "This machine",
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: () => Effect.succeed(ready),
    ensureAgentReady: () =>
      Effect.succeed({
        ...ready,
        agentDevice: { baseUrl: "http://daemon.test", token: "daemon-token", entryPath: "/a" },
      }),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: Effect.void,
  };
};

/** A client request as the server it calls receives it, streamed bodies included. */
const webRequest = Effect.fn("webRequest")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const body =
    request.body._tag === "Uint8Array"
      ? request.body.body
      : request.body._tag === "Stream"
        ? new Uint8Array(
            (yield* Stream.runCollect(Stream.orDie(request.body.stream))).flatMap((chunk) => [
              ...chunk,
            ]),
          )
        : undefined;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
  });
});

/**
 * Two environments in one process: the owner's DeviceService behind the real gateway routes,
 * and a linking DeviceService whose only host is a real LinkedDeviceHost calling them.
 */
const linkedPair = Effect.fn("linkedPair")(function* () {
  const peerSettings = yield* Ref.make<Settings>({
    ...DEFAULT_SERVER_SETTINGS,
    enableDeviceSupport: true,
    enableAgentDeviceAccess: true,
    deviceOnboardingCompleted: true,
    linkedEnvironmentsEnabled: true,
  });
  const peerDevices = yield* DeviceService.makeWithHosts(
    new Map([[LOCAL_DEVICE_HOST_ID, peerHost()]]),
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(ServerSettings.ServerSettingsService, settingsService(peerSettings)),
  );
  const daemonCalls: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  const hubCalls: Array<string> = [];
  /** Every request the owner's daemon received, as sent. */
  const daemonRequests: Array<HttpClientRequest.HttpClientRequest> = [];
  /** What the owner's hub streams back; a test swaps in one that never ends. */
  const hubBody: { make: () => Uint8Array | ReadableStream<Uint8Array> } = {
    make: () => new Uint8Array([1, 2, 3]),
  };
  const daemon = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.startsWith("http://hub.test")) {
        hubCalls.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          new Response(hubBody.make(), { headers: { "content-type": "video/avcc" } }),
        );
      }
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      daemonCalls.push({ url: request.url, authorization: request.headers.authorization, body });
      daemonRequests.push(request);
      const answer = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      return HttpClientResponse.fromWeb(
        request,
        body?.params?.meta?.requestProgress
          ? new Response(`{"progress":1}\n${answer}\n`, {
              headers: { "content-type": "application/x-ndjson" },
            })
          : new Response(answer, { headers: { "content-type": "application/json" } }),
      );
    }),
  );
  const sessions: Record<string, { sessionId: string; label: string; access: string }> = {
    [LINK_TOKEN]: { sessionId: "link-laptop", label: "Laptop", access: "full-access" },
    [OTHER_LINK_TOKEN]: { sessionId: "link-desk", label: "Desk", access: "full-access" },
    "read-only-token": { sessionId: "link-ro", label: "Viewer", access: "read-only" },
  };
  const peerOnly = new Set<string>(["mcp-client-token"]);
  const { handler, dispose } = HttpRouter.toWebHandler(
    Layer.mergeAll(LinkedDeviceGateway.layer, LinkedDeviceTunnel.layer).pipe(
      // Route handlers read these per request, so they are part of what the app provides.
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(DeviceService.DeviceService)(peerDevices),
          Layer.succeed(ServerSettings.ServerSettingsService, settingsService(peerSettings)),
          Layer.succeed(HttpClient.HttpClient, daemon),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: PEER_ENV,
              label: "Studio Mac",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0",
              capabilities: { repositoryIdentity: false },
            }),
          }),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateMcpClient: (request) => {
              const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
              const session = sessions[token];
              if (session)
                return Effect.succeed({
                  sessionId: session.sessionId,
                  label: session.label,
                  access: session.access,
                  peerLink: true,
                } as EnvironmentAuth.McpClientSession);
              if (peerOnly.has(token))
                return Effect.succeed({
                  sessionId: "mcp-plain",
                  label: "An MCP client",
                  access: "full-access",
                  peerLink: false,
                } as EnvironmentAuth.McpClientSession);
              return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError());
            },
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const call = (request: Request) => Effect.promise(() => handler(request, Context.empty()));

  const linkUp = yield* Ref.make(true);
  const outcomes: Array<string | null> = [];
  const toPeer = HttpClient.make((request) =>
    Effect.flatMap(Ref.get(linkUp), (up) =>
      up
        ? webRequest(request).pipe(
            Effect.flatMap(call),
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          )
        : Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "link down" }),
            }),
          ),
    ),
  );
  const linkedHost = yield* LinkedDeviceHost.make({
    link: {
      environmentId: PEER_ENV,
      label: "Studio",
      resolve: Effect.flatMap(Ref.get(linkUp), (up) =>
        up
          ? Effect.succeed({ url: "http://peer.test", token: LINK_TOKEN })
          : Effect.fail(
              new PeerLinkError({ reason: "unreachable", message: "No address answered." }),
            ),
      ),
      recordOutcome: (outcome) => Effect.sync(() => void outcomes.push(outcome.error)),
    },
    localOrigin: "http://127.0.0.1:3773",
  }).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, toPeer));
  const linkingSettings = yield* Ref.make<Settings>({
    ...DEFAULT_SERVER_SETTINGS,
    enableDeviceSupport: true,
    enableAgentDeviceAccess: true,
    deviceOnboardingCompleted: true,
    linkedEnvironmentsEnabled: true,
  });
  /** The daemon each agent launcher here was configured with, as agent-device reads it. */
  const configured: Array<{ readonly baseUrl: string; readonly token: string }> = [];
  const linkingDevices = yield* DeviceService.makeWithHosts(
    new Map([[LINKED_HOST, linkedHost]]),
    undefined,
    (_hostId, endpoint) =>
      Effect.sync(() => {
        configured.push({ baseUrl: endpoint.baseUrl, token: endpoint.token });
        return "/state/agent-device.json";
      }),
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.provideService(ServerSettings.ServerSettingsService, settingsService(linkingSettings)),
  );

  // This server's tunnel, routing launcher calls the way DeviceService.make does.
  const tunnelApp = HttpRouter.toWebHandler(
    LinkedDeviceTunnel.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(DeviceService.DeviceService)({
            linkedAgentUpstream: (hostId, token, path) =>
              hostId === LINKED_HOST ? linkedHost.agentUpstream(token, path) : Effect.succeedNone,
          }),
          Layer.succeed(HttpClient.HttpClient, toPeer),
        ),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(tunnelApp.dispose));
  /** One `/rpc` call as agent-device's CLI sends it to the daemon its launcher names. */
  const launch = (body: unknown) =>
    Effect.promise(() => {
      const endpoint = configured.at(-1)!;
      return tunnelApp.handler(
        new Request(`${endpoint.baseUrl}/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            "x-agent-device-token": endpoint.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        Context.empty(),
      );
    }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())));

  /** A raw call to the gateway, as a linked environment's server makes it. */
  const gateway = (path: string, body: unknown, token = LINK_TOKEN) =>
    call(
      new Request(`http://peer.test${LINKED_DEVICE_ROUTE_PREFIX}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const agentRpc = (deviceId: string, thread: string, body: unknown, token = LINK_TOKEN) =>
    call(
      new Request(`http://peer.test${LINKED_DEVICE_ROUTE_PREFIX}/agent/${deviceId}/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "t3-linked-thread": thread,
        },
        body: JSON.stringify(body),
      }),
    );
  const hub = (path: string, token = LINK_TOKEN) =>
    call(
      new Request(`http://peer.test${LINKED_DEVICE_ROUTE_PREFIX}/hub${path}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  return {
    configured,
    launch,
    hub,
    hubCalls,
    hubBody,
    peerDevices,
    peerSettings,
    linkingDevices,
    linkedHost,
    linkUp,
    outcomes,
    daemonCalls,
    daemonRequests,
    call,
    gateway,
    agentRpc,
  };
});

const command = (name: string, flags: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "agent_device.command",
  params: { command: name, positionals: [], flags, session: "agent-picked" },
});

const json = (response: Response) => Effect.promise(() => response.json());

describe("linked devices", () => {
  it.effect("lists the owner's devices under the linked environment, attributed", () =>
    Effect.gen(function* () {
      const { linkingDevices } = yield* linkedPair();
      const state = yield* linkingDevices.list;
      expect(state.hosts.find((host) => host.id === LINKED_HOST)).toMatchObject({
        kind: "linked",
        label: "Studio Mac",
        environmentId: PEER_ENV,
        linkState: "connected",
      });
      expect(state.devices.map((device) => [device.hostId, device.id, device.physical])).toEqual(
        expect.arrayContaining([
          [LINKED_HOST, SIM, false],
          [LINKED_HOST, PHONE, true],
        ]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("opens for a linked thread named in the link's namespace, and closes there", () =>
    Effect.gen(function* () {
      const { linkingDevices, peerDevices } = yield* linkedPair();
      yield* linkingDevices.list;
      yield* linkingDevices.open({
        threadId: ThreadId.make("thread-a"),
        hostId: LINKED_HOST,
        deviceId: SIM,
        platform: "ios",
      });
      const peerSessions = (yield* peerDevices.state).sessions;
      expect(peerSessions).toEqual([
        expect.objectContaining({
          threadId: "linked:link-laptop:thread-a",
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: SIM,
          linked: { label: "Laptop" },
        }),
      ]);
      yield* linkingDevices.close({
        threadId: ThreadId.make("thread-a"),
        hostId: LINKED_HOST,
        deviceId: SIM,
      });
      expect((yield* peerDevices.state).sessions).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("takes over and hands back on the owner's side, each side naming the other", () =>
    Effect.gen(function* () {
      const { linkingDevices, peerDevices } = yield* linkedPair();
      yield* linkingDevices.list;
      yield* linkingDevices.setHold({ hostId: LINKED_HOST, deviceId: SIM, held: true });
      expect((yield* peerDevices.state).holds).toEqual([
        expect.objectContaining({ deviceId: SIM, linked: { label: "Laptop" } }),
      ]);
      // The linking side's own hold carries no attribution there.
      const mine = (yield* linkingDevices.list).holds ?? [];
      expect(mine).toEqual([expect.objectContaining({ hostId: LINKED_HOST, deviceId: SIM })]);
      expect(mine[0]?.linked).toBeUndefined();
      yield* linkingDevices.setHold({ hostId: LINKED_HOST, deviceId: SIM, held: false });
      expect((yield* peerDevices.state).holds ?? []).toEqual([]);

      // The owner's own hold shows on the linking side under the owner's label.
      yield* peerDevices.setHold({ hostId: LOCAL_DEVICE_HOST_ID, deviceId: SIM, held: true });
      expect((yield* linkingDevices.list).holds).toEqual([
        expect.objectContaining({ deviceId: SIM, linked: { label: "Studio Mac" } }),
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("shows the link down, and connected again once it answers", () =>
    Effect.gen(function* () {
      const { linkingDevices, linkUp } = yield* linkedPair();
      yield* linkingDevices.list;
      yield* Ref.set(linkUp, false);
      // The resolved address is reused for a minute; past it, the link is asked again.
      yield* TestClock.adjust("61 seconds");
      const down = yield* linkingDevices.list;
      expect(down.hosts.find((entry) => entry.id === LINKED_HOST)).toMatchObject({
        kind: "linked",
        linkState: "link_down",
        linkDetail: expect.stringContaining("No address answered"),
      });
      expect(down.hostStatuses[LINKED_HOST]).toMatchObject({ status: "failed" });
      yield* Ref.set(linkUp, true);
      yield* linkingDevices.list;
      expect(
        (yield* linkingDevices.state).hosts.find((entry) => entry.id === LINKED_HOST),
      ).toMatchObject({ linkState: "connected" });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "no link token", token: "", status: 401, state: "link_down" },
    {
      name: "an MCP client that is not a link",
      token: "mcp-client-token",
      status: 403,
      state: "not_allowed",
    },
    { name: "a read-only link", token: "read-only-token", status: 403, state: "not_allowed" },
  ])("refuses $name", ({ token, status, state }) =>
    Effect.gen(function* () {
      const { gateway } = yield* linkedPair();
      const response = yield* gateway("/list", {}, token);
      expect(response.status).toBe(status);
      expect(yield* json(response)).toMatchObject({ state });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "Linked environments off",
      patch: { linkedEnvironmentsEnabled: false },
      status: 403,
      state: "linked_environments_off",
    },
    {
      name: "devices off",
      patch: { enableDeviceSupport: false },
      status: 409,
      state: "devices_off",
    },
    {
      name: "a blocked link",
      patch: { deviceBlockedLinks: [{ linkId: "link-laptop", label: "Laptop" }] },
      status: 403,
      state: "not_allowed",
    },
  ])("refuses a link while the owner has $name", ({ patch, status, state }) =>
    Effect.gen(function* () {
      const { gateway, peerSettings } = yield* linkedPair();
      yield* Ref.update(peerSettings, (current) => ({ ...current, ...patch }) as Settings);
      const response = yield* gateway("/list", {});
      expect(response.status).toBe(status);
      expect(yield* json(response)).toMatchObject({ state });
    }).pipe(Effect.scoped),
  );

  it.effect("proxies an agent's command to the daemon pinned to the thread's session", () =>
    Effect.gen(function* () {
      const { gateway, agentRpc, daemonCalls, peerDevices } = yield* linkedPair();
      const opened = yield* gateway("/open", {
        thread: { id: "thread-a", title: "Fix login" },
        deviceId: SIM,
        platform: "ios",
        agent: true,
      });
      expect(opened.status).toBe(200);
      expect(yield* json(opened)).toMatchObject({ agentDeviceId: SIM });
      const answer = yield* agentRpc(SIM, "thread-a", command("tap", { udid: SIM }));
      expect(answer.status).toBe(200);
      expect(JSON.parse((yield* Effect.promise(() => answer.text())).trim())).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      });
      expect(daemonCalls).toEqual([
        {
          url: "http://daemon.test/rpc",
          authorization: "Bearer daemon-token",
          body: expect.objectContaining({
            params: expect.objectContaining({ command: "tap", session: expect.any(String) }),
          }),
        },
      ]);
      expect(daemonCalls[0]?.body).not.toMatchObject({ params: { session: "agent-picked" } });

      // The owner taking the device over stops the agent at the daemon's door, not only in a launcher.
      yield* peerDevices.setHold({ hostId: LOCAL_DEVICE_HOST_ID, deviceId: SIM, held: true });
      const held = yield* json(yield* agentRpc(SIM, "thread-a", command("tap")));
      expect(held).toMatchObject({
        error: { message: expect.stringContaining("The user is holding this device") },
      });
      expect(daemonCalls).toHaveLength(1);
      // Reading the screen still works while held.
      const look = yield* agentRpc(SIM, "thread-a", command("snapshot"));
      expect(yield* json(look)).toMatchObject({ result: { ok: true } });
      expect(daemonCalls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("passes progress lines through and reaches the daemon's other routes", () =>
    Effect.gen(function* () {
      const { gateway, agentRpc, call, daemonCalls, daemonRequests } = yield* linkedPair();
      yield* gateway("/open", {
        thread: { id: "thread-a" },
        deviceId: SIM,
        platform: "ios",
        agent: true,
      });
      const progress = yield* agentRpc(SIM, "thread-a", {
        ...command("install"),
        params: { ...command("install").params, meta: { requestProgress: "command" } },
      });
      expect(progress.headers.get("content-type")).toBe("application/x-ndjson");
      expect(yield* Effect.promise(() => progress.text())).toBe(
        `{"progress":1}\n{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n`,
      );

      const agentCall = (path: string, init: RequestInit = {}) =>
        call(
          new Request(`http://peer.test${LINKED_DEVICE_ROUTE_PREFIX}/agent/${SIM}${path}`, {
            ...init,
            headers: {
              authorization: `Bearer ${LINK_TOKEN}`,
              "t3-linked-thread": "thread-a",
              ...init.headers,
            },
          }),
        ).pipe(Effect.tap((response) => Effect.promise(() => response.text())));
      expect((yield* agentCall("/health")).status).toBe(200);
      expect((yield* agentCall("/artifacts/a1/shot.png?x=1")).status).toBe(200);
      const upload = yield* agentCall("/upload", {
        method: "POST",
        body: new Uint8Array([9, 9]),
        headers: {
          "content-type": "application/octet-stream",
          "x-artifact-type": "file",
          "x-artifact-filename": "app.ipa",
          "x-artifact-hash": "abc",
          "x-artifact-hash-algorithm": "sha256",
          cookie: "owner=1",
        },
      });
      expect(upload.status).toBe(200);
      // The preflight answers with the daemon's token, so it never leaves this machine.
      expect((yield* agentCall("/upload/preflight", { method: "POST" })).status).toBe(404);
      expect((yield* agentCall("/health", { method: "DELETE" })).status).toBe(404);

      expect(daemonCalls.map((call) => call.url)).toEqual([
        "http://daemon.test/rpc",
        "http://daemon.test/health",
        "http://daemon.test/artifacts/a1/shot.png?x=1",
        "http://daemon.test/upload",
      ]);
      const sent = daemonRequests.at(-1)!;
      expect(sent.method).toBe("POST");
      expect(sent.headers).toMatchObject({
        authorization: "Bearer daemon-token",
        "x-artifact-type": "file",
        "x-artifact-filename": "app.ipa",
        "x-artifact-hash": "abc",
        "x-artifact-hash-algorithm": "sha256",
      });
      expect(sent.headers.cookie).toBeUndefined();
      expect(sent.headers["t3-linked-thread"]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "another device", body: command("tap", { serial: PHONE }) },
    {
      name: "a method other than a command",
      body: { jsonrpc: "2.0", id: 1, method: "agent_device.lease.allocate", params: {} },
    },
    { name: "a body that is not JSON", body: "{" },
  ])("refuses an agent command naming $name", ({ body }) =>
    Effect.gen(function* () {
      const { gateway, agentRpc, daemonCalls } = yield* linkedPair();
      yield* gateway("/open", {
        thread: { id: "thread-a" },
        deviceId: SIM,
        platform: "ios",
        agent: true,
      });
      const response = yield* agentRpc(SIM, "thread-a", body);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toMatchObject({ error: { data: { code: "COMMAND_FAILED" } } });
      expect(daemonCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an agent command for a thread with nothing open there", () =>
    Effect.gen(function* () {
      const { agentRpc, daemonCalls } = yield* linkedPair();
      const refused = yield* json(yield* agentRpc(SIM, "thread-a", command("tap")));
      expect(refused).toMatchObject({
        error: { message: expect.stringContaining("Call device_open again") },
      });
      expect(daemonCalls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a device to one lineage across links, and shares it down a delegation", () =>
    Effect.gen(function* () {
      const { gateway } = yield* linkedPair();
      const open = (thread: unknown, token = LINK_TOKEN) =>
        gateway("/open", { thread, deviceId: SIM, platform: "ios", agent: true }, token);
      expect((yield* open({ id: "thread-a", title: "Fix login" })).status).toBe(200);
      // A task thread-a delegated shares the device.
      expect((yield* open({ id: "task-1", ancestors: ["thread-a"] })).status).toBe(200);
      // An unrelated thread of the same link hears which of its own threads has it.
      const sameLink = yield* open({ id: "thread-b" });
      expect(sameLink.status).toBe(409);
      expect(yield* json(sameLink)).toMatchObject({
        error: { _tag: "DeviceInUseError", threadId: "thread-a", threadTitle: "Fix login" },
      });
      // Another link hears only which environment has it, never that environment's threads.
      const otherLink = yield* open({ id: "thread-a" }, OTHER_LINK_TOKEN);
      expect(otherLink.status).toBe(409);
      const text = yield* Effect.promise(() => otherLink.text());
      expect(JSON.parse(text)).toMatchObject({
        error: { _tag: "DeviceInUseError", threadTitle: "a thread of Laptop" },
      });
      expect(text).not.toMatch(/Fix login|link-laptop|thread-a/);
    }).pipe(Effect.scoped),
  );

  it.effect("asks the owner before a link uses an Ask first device, and waits for the answer", () =>
    Effect.gen(function* () {
      const { peerDevices } = yield* linkedPair();
      yield* peerDevices.list;
      const authorize = (threadId: string) =>
        peerDevices.authorizeAgent({
          threadId: ThreadId.make(`linked:link-laptop:${threadId}`),
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: PHONE,
          intent: "open",
          agent: { link: { linkId: "link-laptop", label: "Laptop" }, threadTitle: "Ship" },
        });
      const subscription = yield* peerDevices.subscribe;
      const asked = (state: DeviceServiceState) => (state.linkRequests ?? []).length > 0;
      const waiting = yield* authorize("thread-a").pipe(Effect.exit, Effect.forkChild);
      const request = yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter(asked),
        Stream.runHead,
        Effect.map((state) => Option.getOrThrow(state).linkRequests![0]!),
      );
      expect(request).toMatchObject({
        linkLabel: "Laptop",
        threadTitle: "Ship",
        deviceId: PHONE,
        deviceName: "Pixel 10",
      });
      yield* peerDevices.answerLinkRequest({ requestId: request.requestId, allow: true });
      expect((yield* Fiber.join(waiting))._tag).toBe("Success");
      expect((yield* peerDevices.state).linkRequests).toEqual([]);

      // Unanswered, the agent hears it is pending; the owner can still answer, and that holds.
      const unanswered = yield* authorize("thread-b").pipe(Effect.flip, Effect.forkChild);
      yield* Stream.fromSubscription(subscription).pipe(Stream.filter(asked), Stream.runHead);
      yield* TestClock.adjust("2 minutes");
      expect((yield* Fiber.join(unanswered))._tag).toBe("DeviceAccessPendingError");
      const late = (yield* peerDevices.state).linkRequests ?? [];
      expect(late).toHaveLength(1);
      yield* peerDevices.answerLinkRequest({ requestId: late[0]!.requestId, allow: false });
      expect((yield* authorize("thread-b").pipe(Effect.flip))._tag).toBe("DeviceAccessDeniedError");
      expect((yield* peerDevices.state).linkRequests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("blocking a link ends what it has open, declines its requests and refuses it", () =>
    Effect.gen(function* () {
      const { gateway, peerDevices } = yield* linkedPair();
      yield* gateway("/open", { thread: { id: "thread-a" }, deviceId: SIM, platform: "ios" });
      yield* gateway("/hold", { deviceId: SIM, held: true });
      const subscription = yield* peerDevices.subscribe;
      const declined = yield* peerDevices
        .authorizeAgent({
          threadId: ThreadId.make("linked:link-laptop:thread-b"),
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: PHONE,
          intent: "open",
          agent: { link: { linkId: "link-laptop", label: "Laptop" } },
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.filter((state) => (state.linkRequests ?? []).length > 0),
        Stream.runHead,
      );
      yield* peerDevices.setLinkBlocked({ linkId: "link-laptop", blocked: true });
      expect((yield* Fiber.join(declined))._tag).toBe("DeviceAccessDeniedError");
      const state = yield* peerDevices.state;
      expect(state.sessions).toEqual([]);
      expect(state.holds ?? []).toEqual([]);
      expect(state.linkClients).toEqual([
        { linkId: "link-laptop", label: "Laptop", blocked: true },
      ]);
      expect((yield* gateway("/list", {})).status).toBe(403);
      yield* peerDevices.setLinkBlocked({ linkId: "link-laptop", blocked: false });
      expect((yield* gateway("/list", {})).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a launcher drives the device through this server's tunnel and the owner's daemon",
    () =>
      Effect.gen(function* () {
        const { linkingDevices, configured, launch, linkUp, daemonCalls } = yield* linkedPair();
        const opened = { threadId: ThreadId.make("thread-a"), hostId: LINKED_HOST, deviceId: SIM };
        yield* linkingDevices.list;
        yield* linkingDevices.open({ ...opened, platform: "ios" }, { agent: {} });
        const target = yield* linkingDevices.agentTarget({ ...opened, agent: {} });
        expect(target.agentDeviceId).toBe(SIM);
        // agent-device is pointed at this server, never at the owner's daemon or with its token.
        expect(configured.at(-1)!.baseUrl).toMatch(
          new RegExp(`^http://127\\.0\\.0\\.1:3773/api/linked-device-agent/${LINKED_HOST}/`),
        );
        expect(configured.at(-1)!.token).not.toBe("daemon-token");

        expect(yield* launch(command("tap", { udid: SIM }))).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true },
        });
        expect(daemonCalls).toEqual([
          expect.objectContaining({
            url: "http://daemon.test/rpc",
            authorization: "Bearer daemon-token",
          }),
        ]);

        // A dead link reaches the agent as agent-device's own error, so it reports it. The tunnel
        // runs on the real clock, so the host may still hold the link's address and fail the call.
        yield* Ref.set(linkUp, false);
        yield* TestClock.adjust("61 seconds");
        expect(yield* launch(command("tap"))).toMatchObject({
          error: {
            message: expect.stringMatching(/not reachable over the link|stopped answering/),
          },
        });
        expect(daemonCalls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
});

describe("linked device streams", () => {
  it.effect("relay only devices the link opened, named in every request", () =>
    Effect.gen(function* () {
      const { gateway, hub, hubCalls } = yield* linkedPair();
      const stream = `/vendor/serve-sim/helper/${SIM}/stream.avcc`;
      expect((yield* hub(stream)).status).toBe(403);
      yield* gateway("/open", { thread: { id: "thread-a" }, deviceId: SIM, platform: "ios" });
      const watched = yield* hub(stream);
      expect(watched.status).toBe(200);
      expect(watched.headers.get("content-type")).toBe("video/avcc");
      expect([...new Uint8Array(yield* Effect.promise(() => watched.arrayBuffer()))]).toEqual([
        1, 2, 3,
      ]);
      expect(hubCalls).toEqual([`http://hub.test${stream}`]);
      // A listing names no device, and a request naming one more device than it opened is refused.
      expect((yield* hub("/api/devices")).status).toBe(403);
      expect((yield* hub(`/vendor/serve-emu/api/screenshot?device=${PHONE}`)).status).toBe(403);
      expect((yield* hub(`${stream}?udid=${PHONE}`)).status).toBe(403);
      // Another link sees nothing of this link's open device.
      expect((yield* hub(stream, OTHER_LINK_TOKEN)).status).toBe(403);
      expect(hubCalls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("end a live stream when the owner blocks the link", () =>
    Effect.gen(function* () {
      const { gateway, hub, hubBody, peerDevices } = yield* linkedPair();
      hubBody.make = () =>
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new Uint8Array([9])),
        });
      yield* gateway("/open", { thread: { id: "thread-a" }, deviceId: SIM, platform: "ios" });
      const watched = yield* hub(`/vendor/serve-sim/helper/${SIM}/stream.avcc`);
      const reader = watched.body!.getReader();
      expect((yield* Effect.promise(() => reader.read())).value).toEqual(new Uint8Array([9]));
      yield* peerDevices.setLinkBlocked({ linkId: "link-laptop", blocked: true });
      expect((yield* Effect.promise(() => reader.read())).done).toBe(true);
    }).pipe(Effect.scoped),
  );
});

describe("linked device tunnel", () => {
  const tunnel = (upstream: DeviceService.DeviceService["Service"]["linkedAgentUpstream"]) => {
    const forwarded: Array<{ url: string; authorization: string | undefined }> = [];
    const { handler, dispose } = HttpRouter.toWebHandler(
      LinkedDeviceTunnel.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(DeviceService.DeviceService)({ linkedAgentUpstream: upstream }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  forwarded.push({
                    url: request.url,
                    authorization: request.headers.authorization,
                  });
                  return HttpClientResponse.fromWeb(request, Response.json({ result: { ok: 1 } }));
                }),
              ),
            ),
          ),
        ),
      ),
      { disableLogger: true },
    );
    const send = (path: string, bearer: string) =>
      Effect.promise(() =>
        handler(
          new Request(
            `http://127.0.0.1:3773${LinkedDeviceHost.LINKED_DEVICE_AGENT_ROUTE_PREFIX}${path}`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
              body: "{}",
            },
          ),
          Context.empty(),
        ),
      );
    return { send, forwarded, dispose };
  };

  it.effect.each([
    {
      name: "a token it never issued",
      upstream: () => Effect.succeedNone,
      bearer: "tok",
      message: "connection here ended",
    },
    {
      name: "a bearer that is not the token",
      upstream: () => Effect.die("not reached"),
      bearer: "other",
      message: "Call device_open again",
    },
    {
      name: "a link that is down",
      upstream: () =>
        Effect.fail(
          new DeviceHostUnavailableError({
            hostId: LINKED_HOST,
            reason: "Studio Mac is not reachable over the link: No address answered.",
          }),
        ),
      bearer: "tok",
      message: "not reachable over the link",
    },
  ])("answers $name as an agent-device error the CLI prints", ({ upstream, bearer, message }) =>
    Effect.gen(function* () {
      const { send, forwarded, dispose } = tunnel(upstream);
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const response = yield* send(`/${LINKED_HOST}/tok/rpc`, bearer);
      expect(response.status).toBe(200);
      expect(yield* json(response)).toMatchObject({
        error: { message: expect.stringContaining(message), data: { code: "COMMAND_FAILED" } },
      });
      expect(forwarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("forwards a launcher's call with the link's credentials, never its own", () =>
    Effect.gen(function* () {
      const { send, forwarded, dispose } = tunnel((hostId, token, path) =>
        Effect.succeed(
          hostId === LINKED_HOST && token === "tok"
            ? Option.some({
                url: `http://peer.test/agent/${SIM}${path}`,
                headers: { authorization: `Bearer ${LINK_TOKEN}` },
                protocols: [],
              })
            : Option.none(),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const response = yield* send(`/${LINKED_HOST}/tok/rpc`, "tok");
      expect(yield* json(response)).toEqual({ result: { ok: 1 } });
      expect(forwarded).toEqual([
        { url: `http://peer.test/agent/${SIM}/rpc`, authorization: `Bearer ${LINK_TOKEN}` },
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("linked device gateway helpers", () => {
  const binding = { session: "s-1", agentDeviceId: "UDID-1" };

  it.each([
    { name: "progress lines", meta: { requestProgress: "command" }, streams: true },
    { name: "replay progress", meta: { requestProgress: "replay-test" }, streams: true },
    { name: "a plain answer", meta: {}, streams: false },
  ])("pins the session and keeps $name", ({ meta, streams }) => {
    const rewritten = LinkedDeviceGateway.rewriteRpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "agent_device.command",
        params: { command: "screenshot", flags: { udid: "UDID-1" }, session: "x", meta },
      }),
      binding,
    );
    expect(rewritten).toMatchObject({ _tag: "Forward", command: "screenshot", streams });
    if (rewritten._tag === "Forward")
      expect(JSON.parse(rewritten.body).params).toMatchObject({ session: "s-1", meta });
  });

  it.each([
    ["not JSON", "nope"],
    ["an array", "[]"],
    ["another method", JSON.stringify({ method: "agent_device.lease.allocate", params: {} })],
    ["no params", JSON.stringify({ method: "agent_device.command" })],
    [
      "no command name",
      JSON.stringify({ method: "agent_device.command", params: { command: "" } }),
    ],
    [
      "flags that are not an object",
      JSON.stringify({ method: "agent_device.command", params: { command: "tap", flags: [] } }),
    ],
    [
      "another device's udid",
      JSON.stringify({
        method: "agent_device.command",
        params: { command: "tap", flags: { udid: "B" } },
      }),
    ],
    [
      "another device's serial",
      JSON.stringify({
        method: "agent_device.command",
        params: { command: "tap", flags: { serial: "B" } },
      }),
    ],
  ])("refuses %s", (_name, body) => {
    expect(LinkedDeviceGateway.rewriteRpc(body, binding)._tag).toBe("Refused");
  });

  it.each([
    ["/vendor/serve-sim/helper/SIM%2D9/frame", "", ["SIM-9"]],
    ["/stream", "device=emulator-5554", ["emulator-5554"]],
    ["/x", "udid=U&serial=S", ["U", "S"]],
    ["/vendor/serve-sim/helper/A/ws", "device=B", ["A", "B"]],
    ["/api/devices", "", []],
  ])("reads every device a hub request names in %s?%s", (path, search, expected) => {
    expect(LinkedDeviceGateway.hubDeviceIds(path, new URLSearchParams(search))).toEqual(expected);
  });

  it.effect("keeps a slow answer alive with spaces, then sends it whole", () =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<string>();
      const collected = yield* LinkedDeviceGateway.keepAlive(Deferred.await(answer)).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust(LinkedDeviceGateway.RPC_KEEPALIVE);
      yield* TestClock.adjust(LinkedDeviceGateway.RPC_KEEPALIVE);
      yield* Deferred.succeed(answer, '{"result":1}');
      const chunks = yield* Fiber.join(collected);
      expect(chunks.join("")).toMatch(/^ +\{"result":1\}$/);
      expect(JSON.parse(chunks.join(""))).toEqual({ result: 1 });
    }),
  );
});

describe("linked hosts follow the links", () => {
  const link = (environmentId: string, label: string): PeerLink => ({
    environmentId: EnvironmentId.make(environmentId),
    label,
    urls: ["http://peer.test"],
    access: "full-access",
    linkedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(Date.UTC(2100, 0)),
    lastReachedAt: null,
    lastError: null,
  });

  it.effect("appear, hide, come back and end their sessions there when the link goes", () =>
    Effect.gen(function* () {
      const links = yield* Ref.make<ReadonlyArray<PeerLink>>([link("env-studio", "Studio")]);
      const peerCalls: Array<string> = [];
      // The linked environment's gateway, answering the calls a linked host makes.
      const peer = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname.slice(LINKED_DEVICE_ROUTE_PREFIX.length);
          peerCalls.push(path);
          const device = {
            hostId: LOCAL_DEVICE_HOST_ID,
            id: PHONE,
            name: "Pixel 10",
            platform: "android",
            version: "Android 16",
            booted: true,
            physical: true,
          };
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              path === "/list"
                ? {
                    environmentLabel: "Studio Mac",
                    platforms: [{ platform: "android", available: true }],
                    agentAccessEnabled: true,
                    agentDeviceVersion: AGENT_DEVICE_VERSION,
                    devices: [device],
                    holds: [],
                  }
                : path === "/open"
                  ? { device, agentDeviceId: null }
                  : {},
            ),
          );
        }),
      );
      const service = yield* DeviceService.make.pipe(
        Effect.provideService(DeviceHost.DeviceHost, peerHost()),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die("Linked hosts install nothing here"),
        }),
        Effect.provideService(HttpClient.HttpClient, peer),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Linked hosts run nothing here")),
        ),
        Effect.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            stored: Ref.get(links),
            resolve: () =>
              Effect.succeed({ url: "http://peer.test", token: LINK_TOKEN } as ResolvedPeerLink),
            recordOutcome: () => Effect.void,
          }),
        ),
      );
      const settings = yield* ServerSettings.ServerSettingsService;
      const linkedHosts = (state: DeviceServiceState) =>
        state.hosts.filter((host) => host.kind === "linked").map((host) => host.id);

      // The beta off (the default) lists no linked environment.
      yield* settings.updateSettings({
        enableDeviceSupport: true,
        deviceOnboardingCompleted: true,
      });
      expect(linkedHosts(yield* service.list)).toEqual([]);

      yield* settings.updateSettings({ linkedEnvironmentsEnabled: true });
      const listed = yield* service.list;
      expect(linkedHosts(listed)).toEqual([LINKED_HOST]);
      expect(listed.devices).toContainEqual(
        expect.objectContaining({ hostId: LINKED_HOST, id: PHONE }),
      );

      yield* settings.updateSettings({ hiddenLinkedDeviceSources: [PEER_ENV] });
      expect(linkedHosts(yield* service.list)).toEqual([]);
      yield* settings.updateSettings({ hiddenLinkedDeviceSources: [] });
      expect(linkedHosts(yield* service.list)).toEqual([LINKED_HOST]);

      yield* service.open({
        threadId: ThreadId.make("thread-a"),
        hostId: LINKED_HOST,
        deviceId: PHONE,
        platform: "android",
      });
      expect((yield* service.state).sessions).toHaveLength(1);
      peerCalls.length = 0;
      yield* Ref.set(links, []);
      const after = yield* service.list;
      expect(linkedHosts(after)).toEqual([]);
      expect(after.sessions).toEqual([]);
      expect(peerCalls).toContain("/close");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest(),
          Layer.succeed(SecretResolver.SecretResolver, {
            label: (provider) => Effect.succeed(provider),
            read: (references) => Effect.succeed(references.map(() => undefined)),
            invalidate: () => Effect.void,
          }),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-linked-hosts-" }),
          NodeCrypto.layer,
          NetService.layer,
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
  );
});
