import {
  DeviceAccessDeniedError,
  type DeviceAccessMap,
  DeviceAccessPendingError,
  deviceAccessKey,
  legacyDeviceAccessKey,
  deviceAccessPolicy,
  type DeviceActionInput,
  DeviceActionUnavailableError,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  DeviceHeldError,
  type DeviceHold,
  DeviceHostId,
  DeviceId,
  DeviceHostUnavailableError,
  DeviceInUseError,
  deviceIssueBlocks,
  DeviceNotFoundError,
  DeviceNotReadyError,
  isAppleTeamId,
  isCaptureDevice,
  isDesktopDevice,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceSetAccessInput,
  type DeviceForgetInput,
  type DeviceWifiPairCancelInput,
  type DeviceWifiPairStartInput,
  type DeviceWifiPairStartResult,
  DeviceWifiPairingBusyError,
  type DeviceSetHoldInput,
  type DeviceShutdownInput,
  type DeviceSummary,
  type DeviceEasAccount,
  DeviceEasAccountError,
  type DeviceEasAccountInput,
  type DeviceSimlockIdentity,
  DeviceSimlockIdentityError,
  type DeviceSimlockIdentityInput,
  type DeviceHostConfig,
  type EasDeviceHostConfig,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
  type DeviceHostSummary,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type ThreadId,
} from "@t3tools/contracts";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as FileSystem from "effect/FileSystem";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Path from "effect/Path";
import { ensureAgentDevice, ensureDeviceHub } from "./DeviceToolchain.ts";
import {
  AGENT_DEVICE_RELEASE_ENV,
  agentDeviceCloseOutcome,
  agentDeviceHoldMarker,
  bindAgentDeviceLauncher,
  clearAgentDeviceHolds,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
  setAgentDeviceHold,
} from "./AgentDeviceShim.ts";
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceHoldName,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as AdbWifiPairing from "./AdbWifiPairing.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import * as SimlockDeviceHost from "./SimlockDeviceHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeExpoApi } from "./ExpoApi.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as CaptureDevices from "./CaptureDevices.ts";
import * as MacVideoCapture from "./MacVideoCapture.ts";

export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

const isSshCommandError = Schema.is(SshCommandError);

const sshProbeFailureMessage = (error: DeviceHost.DeviceHostError): string => {
  const windows = SshDeviceHost.isSshWindowsHostError(error.cause) ? error.cause : null;
  const cause = windows ? windows.cause : error.cause;
  if (
    !isSshCommandError(cause) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    (cause.exitCode > 254 && cause.exitCode !== 9009)
  )
    return "Could not connect to this host over SSH.";

  // Only the known bootstrap diagnostic is safe to expose as Node guidance.
  if (
    cause.exitCode === 1 &&
    cause.stderr
      .split(/\r?\n/u)
      .some((line) => line.trim() === "Node is missing from the non-interactive SSH PATH")
  )
    return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.";
  if (windows) return windows.message;

  return `Connected over SSH, but the device host check failed (exit code ${cause.exitCode}).`;
};

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
}

export interface DeviceReadiness extends DeviceHost.DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export interface DeviceAgentReadiness extends DeviceReadiness {
  /** Null when each device has its own daemon; see `DeviceOperations.agentEndpoint`. */
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint | null;
}

const DeviceHostName = Schema.Struct({ id: DeviceHostId, label: Schema.optional(Schema.String) });
const hostName = (host: typeof DeviceHostName.Type) => host.label ?? `host ${host.id}`;

export class DeviceHostAmbiguousError extends Schema.TaggedError<DeviceHostAmbiguousError>()(
  "DeviceHostAmbiguousError",
  { deviceId: DeviceId, hosts: Schema.Array(DeviceHostName) },
) {
  override get message(): string {
    return `Device ${this.deviceId} is on more than one host: ${this.hosts.map(hostName).join(", ")}.`;
  }
}

export class DeviceOnOtherHostError extends Schema.TaggedError<DeviceOnOtherHostError>()(
  "DeviceOnOtherHostError",
  { deviceId: DeviceId, host: DeviceHostName, hosts: Schema.Array(DeviceHostName) },
) {
  override get message(): string {
    return `Device ${this.deviceId} is not on ${hostName(this.host)}. It is on ${this.hosts.map(hostName).join(", ")}.`;
  }
}

export interface DeviceAccessQuestion {
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly hostLabel: string;
}

export type DeviceAccessAnswer = "allowed" | "declined" | "pending";

/** The agent a device call is made for. Calls from the user's own client carry none and are not gated. */
export interface DeviceAgentCaller {
  readonly threadTitle?: string | undefined;
  /**
   * The threads that delegated to this one, nearest first. A thread shares a device, its
   * agent-device session and its access answer with them; orchestration sits above this service.
   */
  readonly ancestors?: ReadonlyArray<ThreadId> | undefined;
  /** Asks the user whether this thread may use the device. Without it an unanswered ask stays pending. */
  readonly ask?: (question: DeviceAccessQuestion) => Effect.Effect<DeviceAccessAnswer, DeviceError>;
}

/** `open` starts driving a device, `close` ends it, `read` only looks. */
export type DeviceAgentIntent = "open" | "close" | "read";

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly testHost: (
      config: SshDeviceHostConfig,
    ) => Effect.Effect<DeviceHostSummary, DeviceError>;
    /** Who an Expo credential signs in as and which EAS projects it can run sessions under. */
    readonly easAccount: (
      input: DeviceEasAccountInput,
    ) => Effect.Effect<DeviceEasAccount, DeviceEasAccountError>;
    /** Who a Simlock agent token is; without a gateway or token, this machine's agent-device's. */
    readonly simlockIdentity: (
      input: DeviceSimlockIdentityInput,
    ) => Effect.Effect<DeviceSimlockIdentity, DeviceSimlockIdentityError>;
    /**
     * The agent-device flags that reach the device: its config and session,
     * and the id agent-device selects it by, which can differ from its id here.
     */
    readonly agentTarget: (input: {
      threadId: ThreadId;
      hostId: DeviceHostId;
      deviceId: DeviceId;
      agent?: DeviceAgentCaller | undefined;
    }) => Effect.Effect<
      {
        readonly agentDeviceId: string | null;
        readonly session: string;
        readonly args: ReadonlyArray<string>;
        readonly installDirectory?: string | undefined;
      },
      DeviceError
    >;
    /**
     * The command agents run for one agent-device session; it is removed when the session ends.
     * None when the session closed before it could be bound.
     */
    readonly agentLauncher: (input: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly targetArgs: ReadonlyArray<string>;
      readonly agent?: DeviceAgentCaller | undefined;
    }) => Effect.Effect<Option.Option<string>, DeviceError>;
    /**
     * Whether an agent may do this to a device now: its access policy, another thread's agent
     * already driving it, and the user holding it. Every agent path to a device asks here.
     */
    readonly authorizeAgent: (input: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly intent: DeviceAgentIntent;
      readonly agent?: DeviceAgentCaller | undefined;
    }) => Effect.Effect<void, DeviceError>;
    /** Takes a device over for the user or hands it back. Repeating either changes nothing. */
    readonly setHold: (input: DeviceSetHoldInput) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** The user sent input to a device through the stream; it never fails the stream. */
    readonly holdOnInput: (
      hostId: DeviceHostId | undefined,
      deviceId: DeviceId,
    ) => Effect.Effect<void>;
    readonly setAccess: (
      input: DeviceSetAccessInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** Starts pairing a phone over Wi-Fi; one attempt per environment, repeats by request id. */
    readonly startWifiPairing: (
      input: DeviceWifiPairStartInput,
    ) => Effect.Effect<DeviceWifiPairStartResult, DeviceError | DeviceWifiPairingBusyError>;
    readonly cancelWifiPairing: (
      input: DeviceWifiPairCancelInput,
    ) => Effect.Effect<DeviceServiceState>;
    /** Disconnects a phone connected over Wi-Fi and ends what was open on it. */
    readonly forgetDevice: (
      input: DeviceForgetInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly state: Effect.Effect<DeviceServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<DeviceServiceState>, never, Scope.Scope>;
    readonly configure: (
      input: DeviceConfigureInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly list: Effect.Effect<DeviceServiceState, DeviceError>;
    readonly updateTool: (tool: "hub" | "agent") => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly inspect: Effect.Effect<DeviceServiceState>;
    readonly retryHost: (hostId: DeviceHostId) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly open: (
      input: DeviceOpenInput,
      context?: DeviceHost.DeviceOpenContext & { readonly agent?: DeviceAgentCaller | undefined },
    ) => Effect.Effect<DeviceSession, DeviceError>;
    readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
    readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly screenshot: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<DeviceScreenshot, DeviceError>;
    /**
     * The device an id names in the last listing. Ids are unique per host, not across hosts (an
     * Android AVD name can exist on two), so a hostId decides, and without one the id has to be
     * on a single host.
     */
    readonly locateDevice: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<
      Option.Option<DeviceSummary>,
      DeviceHostAmbiguousError | DeviceOnOtherHostError
    >;
    /** As `locateDevice`, among the devices a thread has open. */
    readonly locateSession: (input: {
      readonly threadId: ThreadId;
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<
      Option.Option<DeviceSession>,
      DeviceHostAmbiguousError | DeviceOnOtherHostError
    >;
    readonly readiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness, DeviceError>;
    readonly readinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceReadiness | null, DeviceError>;
    readonly agentReadinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceAgentReadiness | null, DeviceError>;
    readonly currentReadiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness | null>;
    /**
     * Routes a proxied path to a capture device's stream; null when it is not one. Capture devices
     * stream without the hub, so the proxy asks this first.
     */
    readonly captureRoute: (
      hostId: DeviceHostId | undefined,
      hubPath: string,
      search: URLSearchParams,
    ) => Effect.Effect<CaptureDevices.CaptureRoute | "unavailable" | null>;
    readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
  }
>()("t3/device/DeviceService") {}

interface ServiceState {
  readonly state: DeviceServiceState;
}

export interface AgentDeviceLaunchers {
  readonly bind: (input: {
    readonly session: string;
    readonly targetArgs: ReadonlyArray<string>;
    readonly hostId: DeviceHostId;
    readonly deviceId: DeviceId;
  }) => Effect.Effect<string, DeviceError>;
  /** Writes the marker a held device's launcher refuses on; a null message removes it. */
  readonly hold?: (
    device: { readonly hostId: DeviceHostId; readonly deviceId: DeviceId },
    message: string | null,
  ) => Effect.Effect<void>;
  /** Removes the markers a previous run left. */
  readonly clearHolds?: Effect.Effect<void>;
  /** Removes every launcher whose session is not in `live`. */
  readonly prune: (live: ReadonlySet<string>) => Effect.Effect<void>;
  /** Ends the agent-device session behind a launcher, which releases its claim on the device. */
  readonly release?: (launcher: string) => Effect.Effect<void>;
}

export const makeWithHosts = Effect.fn("DeviceService.makeWithHosts")(function* (
  hosts: ReadonlyMap<DeviceHostId, DeviceHost.DeviceHost["Service"]>,
  testHost: DeviceService["Service"]["testHost"] = (host) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId: host.id,
        hostLabel: host.label,
        reason: "SSH probing is unavailable in this device service.",
      }),
    ),
  configureAgent: (
    hostId: DeviceHostId,
    endpoint: DeviceHost.AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
    deviceId?: DeviceId,
  ) => Effect.Effect<string, DeviceError> = (hostId) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId,
        reason: "Agent configuration is unavailable in this device service.",
      }),
    ),
  installTool?: (tool: "hub" | "agent") => Effect.Effect<unknown, DeviceError>,
  launchers?: AgentDeviceLaunchers,
  captures?: CaptureDevices.CaptureDevices["Service"],
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const lifecycleLock = yield* Semaphore.make(1);
  const readDeviceSettings = settings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.enableDeviceSupport,
      agentAccessEnabled: value.enableAgentDeviceAccess,
      onboardingCompleted: value.deviceOnboardingCompleted,
      access: value.deviceAccess,
      signingReady: isAppleTeamId(value.appleTeamId.trim()),
    })),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({ operation: "settings", reason: "settings_failed", cause }),
    ),
  );
  const initialSettings = yield* readDeviceSettings;

  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  let publishedHosts = new Map(hosts);
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
      supportsHostRetry: true,
      supportsToolUpdate: installTool !== undefined,
      supportsToolInspection: true,
      supportsEasHosts: true,
      supportsSimlockHosts: true,
      supportsDeviceControl: true,
      supportsWifiPairing: true,
      holds: [],
      access: initialSettings.access,
      hosts: initialHosts,
      hostStatus: initialSettings.enabled ? "idle" : "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: initialSettings.onboardingCompleted,
      agentAccessEnabled: initialSettings.agentAccessEnabled,
      hubBasePath: DEVICE_HUB_ROUTE_PREFIX,
      revision: 0,
    },
  });

  /** Devices the user holds, by `holdKey`. In memory: a restart hands every device back. */
  const holds = new Map<string, DeviceHold>();
  // Holds follow the id the stream and the launcher marker use, not the stored access identity.
  const holdKey = (hostId: DeviceHostId, deviceId: DeviceId) => `${hostId}:${deviceId}`;
  /** What the user answered a delegation tree that had to ask, by its top thread and device. */
  const accessAnswers = new Map<string, boolean>();
  /** Each agent thread's delegating ancestors, nearest first, as its last device call gave them. */
  const lineages = new Map<ThreadId, ReadonlyArray<ThreadId>>();
  const lineageRoot = (threadId: ThreadId) => lineages.get(threadId)?.at(-1) ?? threadId;
  const sameLineage = (a: ThreadId, b: ThreadId) =>
    a === b || lineages.get(a)?.includes(b) === true || lineages.get(b)?.includes(a) === true;
  // A delegation tree drives a device through one agent-device session: the CLI claims a device
  // per session, so a child with its own would be refused by it.
  const sessionName = (session: {
    readonly threadId: ThreadId;
    readonly hostId: DeviceHostId;
    readonly deviceId: DeviceId;
  }) =>
    agentDeviceSession(lineageRoot(session.threadId), session.hostId, session.deviceId).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
  const isSession =
    (target: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
    }) =>
    (session: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
    }) =>
      session.threadId === target.threadId &&
      session.hostId === target.hostId &&
      session.deviceId === target.deviceId;
  const accessLock = yield* Semaphore.make(1);
  const launcherLock = yield* Semaphore.make(1);
  /** Launchers bound since startup, by agent-device session. */
  const boundLaunchers = new Map<string, string>();
  /** Every thread a bound launcher was handed to; one agent-device session can serve a lineage. */
  let launcherOwners: ReadonlyArray<{
    readonly session: string;
    readonly threadId: ThreadId;
    readonly hostId: DeviceHostId;
    readonly deviceId: DeviceId;
    readonly threadTitle?: string | undefined;
  }> = [];
  /** Launchers on a session the host leases to every thread; the host ends it, not a retiring thread. */
  const hostSessionLaunchers = new Set<string>();
  // Binding and pruning read sessions under the lock, so neither acts on a session list the other has outdated.
  // A retired session's agent-device session ends before its launcher goes, and a reopen of the same
  // device waits for the lock, so the close cannot end the reopened session.
  const pruneLaunchers = launcherLock.withPermit(
    Effect.gen(function* () {
      if (!launchers) return;
      const { state } = yield* SynchronizedRef.get(stateRef);
      const live = new Set(yield* Effect.forEach(state.sessions, sessionName));
      const retired = [...boundLaunchers].filter(([session]) => !live.has(session));
      for (const [session] of retired) boundLaunchers.delete(session);
      launcherOwners = launcherOwners.filter((owner) => state.sessions.some(isSession(owner)));
      const ending = retired.filter(([session]) => !hostSessionLaunchers.delete(session));
      const release = launchers.release;
      if (release)
        yield* Effect.forEach(ending, ([, launcher]) => release(launcher), {
          concurrency: "unbounded",
          discard: true,
        });
      yield* launchers.prune(live);
    }),
  );

  /** The agent-device sessions that end with `ending`: none that a thread staying open still uses. */
  const endingSessionNames = Effect.fnUntraced(function* (ending: ReadonlyArray<DeviceSession>) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    const kept = new Set(
      yield* Effect.forEach(
        state.sessions.filter((session) => !ending.includes(session)),
        sessionName,
      ),
    );
    const names = new Map<string, DeviceSession>();
    for (const session of ending) {
      const name = yield* sessionName(session);
      if (!kept.has(name)) names.set(name, session);
    }
    return names;
  });

  const releaseLaunchers = (sessions: ReadonlyArray<DeviceSession>) =>
    launcherLock.withPermit(
      Effect.gen(function* () {
        for (const name of (yield* endingSessionNames(sessions)).keys()) {
          const launcher = boundLaunchers.get(name);
          if (!launcher || hostSessionLaunchers.has(name) || !launchers?.release) continue;
          yield* launchers.release(launcher);
          boundLaunchers.delete(name);
        }
        launcherOwners = launcherOwners.filter(
          (owner) => !sessions.some((session) => isSession(owner)(session)),
        );
      }),
    );

  // Uninterruptible so a committed retirement always prunes, even if its caller is cancelled.
  const publish = (update: (state: DeviceServiceState) => DeviceServiceState) =>
    SynchronizedRef.modifyEffect(stateRef, ({ state }) => {
      const next = { ...update(state), revision: state.revision + 1 };
      const retired = state.sessions.some((session) => !next.sessions.includes(session));
      return PubSub.publish(statePubSub, next).pipe(
        Effect.as([{ next, retired }, { state: next }] as const),
      );
    }).pipe(
      Effect.tap(({ retired }) => (retired ? pruneLaunchers : Effect.void)),
      Effect.map(({ next }) => next),
      Effect.uninterruptible,
    );

  const pairingScope = yield* Scope.Scope;
  /** The environment's one Wi-Fi pairing attempt; the password stays here, never in state. */
  let pairing: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly hostId: DeviceHostId;
    readonly qrPayload: string;
    fiber?: Fiber.Fiber<void>;
    done?: boolean;
  } | null = null;
  const publishPairing = (wifiPairing: DeviceServiceState["wifiPairing"]) =>
    publish(({ wifiPairing: _previous, ...state }) =>
      wifiPairing ? { ...state, wifiPairing } : state,
    );

  /** Stops the running attempt, if any; what it last published is left for the caller to clear. */
  const endWifiPairing = () =>
    Effect.suspend(() => {
      const attempt = pairing;
      pairing = null;
      return attempt?.fiber ? Fiber.interrupt(attempt.fiber) : Effect.void;
    });
  const wifiPairingHost = () => pairing?.hostId;

  const resolveHost = Effect.fn("DeviceService.resolveHost")(function* (
    hostId: DeviceHostId | undefined,
  ) {
    const id = hostId ?? LOCAL_DEVICE_HOST_ID;
    const host = hosts.get(id);
    if (!host) {
      return yield* new DeviceHostUnavailableError({ hostId: id, reason: "Unknown host." });
    }
    return host;
  });

  // Readiness phases replace the shown detail; this restores an incomplete listing's cause once ready.
  const discoveryDetails = new Map<DeviceHostId, string>();

  const setHostStatus = (
    hostId: DeviceHostId,
    status: DeviceServiceState["hostStatuses"][string],
  ) =>
    Effect.suspend(() =>
      !hosts.has(hostId)
        ? SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state))
        : publish((state) => {
            const previous = state.hostStatuses[hostId];
            const detail =
              status.detail ??
              (status.status === "ready" &&
              (previous?.incompletePlatforms || previous?.androidDiscoveryIncomplete)
                ? discoveryDetails.get(hostId)
                : undefined);
            return {
              ...state,
              ...(hostId === LOCAL_DEVICE_HOST_ID
                ? { hostStatus: status.status, hostStatusDetail: detail }
                : {}),
              hostStatuses: {
                ...state.hostStatuses,
                [hostId]: {
                  ...(previous?.androidDiscoveryIncomplete
                    ? { androidDiscoveryIncomplete: true }
                    : {}),
                  ...(previous?.incompletePlatforms
                    ? { incompletePlatforms: previous.incompletePlatforms }
                    : {}),
                  ...status,
                  ...(detail ? { detail } : {}),
                },
              },
            };
          }),
    );

  const isLocalCapture = (device: DeviceSummary) =>
    device.hostId === LOCAL_DEVICE_HOST_ID && isCaptureDevice(device);

  /** Lists capture devices on their own: they need no hub, so a host without one still has them. */
  const refreshCaptures = Effect.gen(function* () {
    if (!captures || !(yield* readDeviceSettings).enabled)
      return (yield* SynchronizedRef.get(stateRef)).state;
    const listed = yield* captures.list;
    return yield* publish((state) => ({
      ...state,
      devices: [
        ...state.devices.filter((device) => !isLocalCapture(device)),
        ...listed.map((device): DeviceSummary => ({ ...device, hostId: LOCAL_DEVICE_HOST_ID })),
      ],
    }));
  }).pipe(Effect.withSpan("DeviceService.refreshCaptures"));

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) {
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason:
            "Device support is off. Enable it in the Device panel before installing or starting device tools.",
        });
      }
      const ready = yield* host
        .ensureReady((status, detail) =>
          setHostStatus(host.id, { status, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error.step === "probe"
                      ? sshProbeFailureMessage(error)
                      : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const { state } = yield* SynchronizedRef.get(stateRef);
      if (state.hostStatuses[host.id]?.status !== "ready") {
        yield* setHostStatus(host.id, { status: "ready" });
      }
      return { hostId: host.id, ...ready };
    },
    lifecycleLock.withPermit,
  );

  const readinessIfSupported: DeviceService["Service"]["readinessIfSupported"] = Effect.fn(
    "DeviceService.readinessIfSupported",
  )(function* (hostId) {
    if (!(yield* readDeviceSettings).enabled) return null;
    const host = yield* resolveHost(hostId);
    const summary = yield* host.summary;
    if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
      return null;
    return yield* readiness(host.id);
  });

  const agentReadinessIfSupported: DeviceService["Service"]["agentReadinessIfSupported"] =
    Effect.fn("DeviceService.agentReadinessIfSupported")(function* (hostId) {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = yield* resolveHost(hostId);
      const summary = yield* host.summary;
      if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
        return null;
      const ready = yield* host
        .ensureAgentReady((phase, detail) =>
          setHostStatus(host.id, { status: phase, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error._tag === "DeviceHostTimeoutError"
                      ? `Agent tools did not start within ${error.timeoutMs} ms.`
                      : error._tag === "AgentDeviceStartError"
                        ? error.message
                        : error.step === "probe"
                          ? sshProbeFailureMessage(error)
                          : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      const hostSummaries = yield* Effect.forEach(hosts.values(), (candidate) => candidate.summary);
      yield* publish((state) => ({ ...state, hosts: hostSummaries }));
      yield* setHostStatus(host.id, { status: "ready" });
      return { hostId: host.id, ...ready };
    }, lifecycleLock.withPermit);

  const currentReadiness: DeviceService["Service"]["currentReadiness"] = (hostId) =>
    resolveHost(hostId).pipe(
      Effect.flatMap((host) =>
        host.current.pipe(Effect.map((ready) => (ready ? { hostId: host.id, ...ready } : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const { devices, detail, androidDiscoveryIncomplete, incompletePlatforms } =
      yield* ready.devices.list;
    return {
      devices: devices.map((device): DeviceSummary => ({ ...device, hostId: ready.hostId })),
      detail,
      androidDiscoveryIncomplete,
      incompletePlatforms: incompletePlatforms ?? [],
    };
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const host = hosts.get(ready.hostId);
    // A session opened while the listing ran is on a device the listing could
    // not have seen yet; only sessions from before it can be pruned by it.
    const sessionKey = (session: DeviceSession) =>
      `${session.hostId}\u0000${session.deviceId}\u0000${session.threadId}\u0000${session.openedAt}`;
    const before = new Set((yield* SynchronizedRef.get(stateRef)).state.sessions.map(sessionKey));
    const { devices, detail, androidDiscoveryIncomplete, incompletePlatforms } =
      yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled || !host || hosts.get(ready.hostId) !== host)
          return (yield* SynchronizedRef.get(stateRef)).state;
        if (detail && (incompletePlatforms.length > 0 || androidDiscoveryIncomplete))
          discoveryDetails.set(ready.hostId, detail);
        else discoveryDetails.delete(ready.hostId);
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter(
              (device) =>
                device.hostId !== ready.hostId ||
                incompletePlatforms.includes(device.platform) ||
                isLocalCapture(device),
            ),
            ...devices.filter(
              (device) =>
                !incompletePlatforms.includes(device.platform) &&
                !(captures && isLocalCapture(device)),
            ),
          ],
          // A host that ends devices itself (EAS stops sessions at their limits)
          // leaves sessions on devices it no longer lists with nothing to stream.
          // Other hosts can miss a device for one listing, so theirs stay.
          sessions: ready.devices.endsDevices
            ? state.sessions.filter(
                (session) =>
                  session.hostId !== ready.hostId ||
                  !before.has(sessionKey(session)) ||
                  devices.some((device) => device.id === session.deviceId),
              )
            : state.sessions,
          hostStatuses: {
            ...state.hostStatuses,
            [ready.hostId]: {
              status: "ready",
              ...(detail ? { detail } : {}),
              ...(androidDiscoveryIncomplete ? { androidDiscoveryIncomplete } : {}),
              ...(incompletePlatforms.length > 0 ? { incompletePlatforms } : {}),
            },
          },
        }));
      }),
    );
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
    yield* Effect.all([refreshCaptures, listHosts], { concurrency: 2, discard: true });
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

  const listHosts = Effect.suspend(() =>
    Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const ready = yield* readinessIfSupported(host.id);
          if (ready) yield* refresh(ready);
        }).pipe(
          Effect.catch((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    ),
  );

  const inspect = Effect.gen(function* () {
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const result = yield* (host.inspect ?? host.summary).pipe(Effect.result);
          if (hosts.get(host.id) !== host) return;
          if (result._tag === "Failure") {
            yield* publish((state) => ({
              ...state,
              hosts: state.hosts.map((value) =>
                value.id === host.id
                  ? {
                      ...value,
                      toolInspectionError:
                        "Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.",
                    }
                  : value,
              ),
            }));
            return;
          }
          yield* publish((state) => ({
            ...state,
            hosts: state.hosts.map((value) => (value.id === host.id ? result.success : value)),
          }));
        }),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  });

  const retryHost: DeviceService["Service"]["retryHost"] = Effect.fn("DeviceService.retryHost")(
    function* (hostId) {
      yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
      yield* Effect.gen(function* () {
        const ready =
          (yield* agentReadinessIfSupported(hostId)) ?? (yield* readinessIfSupported(hostId));
        if (ready) yield* refresh(ready);
      }).pipe(
        Effect.catch((error) =>
          setHostStatus(hostId, {
            status: "failed",
            detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
          }),
        ),
      );
      return (yield* SynchronizedRef.get(stateRef)).state;
    },
  );

  const configure: DeviceService["Service"]["configure"] = Effect.fn("DeviceService.configure")(
    function* (input) {
      const currentSettings = yield* readDeviceSettings;
      const nextEnabled = input.enabled ?? currentSettings.enabled;
      const nextAgentAccess = input.agentAccessEnabled ?? currentSettings.agentAccessEnabled;
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* settings
            .updateSettings({
              ...(input.enabled === undefined ? {} : { enableDeviceSupport: input.enabled }),
              ...(input.agentAccessEnabled === undefined
                ? {}
                : { enableAgentDeviceAccess: input.agentAccessEnabled }),
              ...(input.onboardingCompleted === undefined
                ? {}
                : { deviceOnboardingCompleted: input.onboardingCompleted }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "configure",
                    reason: "settings_failed",
                    cause,
                  }),
              ),
            );
          if (!nextEnabled) {
            yield* endWifiPairing();
            yield* publishPairing(undefined);
            yield* Effect.forEach(hosts.values(), (host) => host.stop, { discard: true });
            if (captures) {
              const { state } = yield* SynchronizedRef.get(stateRef);
              yield* Effect.forEach(
                state.devices.filter(isLocalCapture),
                (device) => captures.stop(device.id),
                { discard: true },
              );
            }
          } else if (input.agentAccessEnabled === false) {
            yield* Effect.forEach(hosts.values(), (host) => host.stopAgent, { discard: true });
          }
          yield* publish((state) => ({
            ...state,
            hostStatus: nextEnabled ? "idle" : "disabled",
            hostStatusDetail: undefined,
            hostStatuses: {},
            devices: nextEnabled ? state.devices : [],
            sessions: nextEnabled ? state.sessions : [],
            bootingDevices: nextEnabled ? state.bootingDevices : [],
            agentAccessEnabled: nextAgentAccess,
            onboardingCompleted: input.onboardingCompleted ?? state.onboardingCompleted,
          }));
        }),
      );
      if (nextEnabled && nextAgentAccess && input.agentAccessEnabled === true) {
        yield* agentReadinessIfSupported();
      }
      return yield* list;
    },
  );

  const findDevice = (
    state: DeviceServiceState,
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    host: DeviceHost.DeviceHost["Service"],
    platform: DevicePlatform,
  ) {
    const availability = yield* host.platformAvailability(platform);
    if (!availability.available) {
      return yield* new DevicePlatformUnavailableError({
        hostId: host.id,
        platform,
        reason: availability.reason ?? "Platform toolchain missing.",
      });
    }
  });

  const publishHolds = publish((state) => ({ ...state, holds: [...holds.values()] }));

  const setHold: DeviceService["Service"]["setHold"] = Effect.fn("DeviceService.setHold")(
    function* (input) {
      const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
      const key = holdKey(hostId, input.deviceId);
      const since = DateTime.formatIso(yield* DateTime.now);
      const { state } = yield* SynchronizedRef.get(stateRef);
      // Checked and changed without yielding between, so a repeat never publishes twice.
      if (holds.has(key) === input.held) return state;
      const device = findDevice(state, hostId, input.deviceId);
      if (input.held && !device) {
        return yield* new DeviceNotFoundError({ hostId, deviceId: input.deviceId });
      }
      const target = { hostId, deviceId: input.deviceId };
      if (input.held) holds.set(key, { ...target, since });
      else holds.delete(key);
      yield* (
        launchers?.hold?.(
          target,
          input.held
            ? new DeviceHeldError({
                ...target,
                ...(device ? { deviceName: device.name } : {}),
                since,
              }).message
            : null,
        ) ?? Effect.void
      );
      return yield* publishHolds;
    },
  );

  // Runs for every input frame, so a held device costs one map lookup and no span.
  const holdOnInput: DeviceService["Service"]["holdOnInput"] = (hostId, deviceId) =>
    Effect.suspend(() =>
      holds.has(holdKey(hostId ?? LOCAL_DEVICE_HOST_ID, deviceId))
        ? Effect.void
        : setHold({ hostId, deviceId, held: true }).pipe(Effect.ignore),
    );

  const publishAccess = (access: DeviceAccessMap) => publish((state) => ({ ...state, access }));

  const setAccess: DeviceService["Service"]["setAccess"] = Effect.fn("DeviceService.setAccess")(
    function* (input) {
      const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
      const { state } = yield* SynchronizedRef.get(stateRef);
      // A device that is not listed has only its id to go by.
      const device = findDevice(state, hostId, input.deviceId) ?? { hostId, id: input.deviceId };
      const key = deviceAccessKey(device);
      const legacyKey = legacyDeviceAccessKey(device);
      // Read and written under one lock: the stored map is replaced whole, unknown entries included.
      return yield* accessLock.withPermit(
        Effect.gen(function* () {
          const {
            [key]: _previous,
            [legacyKey]: _legacy,
            ...rest
          } = (yield* readDeviceSettings).access;
          const access = input.policy === null ? rest : { ...rest, [key]: input.policy };
          yield* settings.updateSettings({ deviceAccess: access }).pipe(
            Effect.mapError(
              (cause) =>
                new DeviceOperationError({
                  operation: "set device access",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          );
          return yield* publishAccess(access);
        }),
      );
    },
  );

  const authorizeAgent: DeviceService["Service"]["authorizeAgent"] = Effect.fn(
    "DeviceService.authorizeAgent",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device = findDevice(state, input.hostId, input.deviceId);
    if (input.agent?.ancestors) lineages.set(input.threadId, input.agent.ancestors);
    const refused = {
      hostId: input.hostId,
      deviceId: input.deviceId,
      ...(device ? { deviceName: device.name } : {}),
    };
    // Ending a session is not using the device, so a policy never keeps one open.
    const deviceSettings = yield* readDeviceSettings;
    if (input.intent !== "close") {
      // Computer use reaches the desktop with device support off too, when it is not listed.
      const subject = device ?? {
        hostId: input.hostId,
        id: input.deviceId,
        physical: isDesktopDevice({ hostId: input.hostId, id: input.deviceId }),
      };
      const policy = deviceAccessPolicy(deviceSettings.access, subject);
      if (policy === "deny") {
        return yield* new DeviceAccessDeniedError({ ...refused, reason: "policy" });
      }
      if (policy === "ask") {
        const answerKey = `${lineageRoot(input.threadId)}\u0000${deviceAccessKey(subject)}`;
        if (!accessAnswers.has(answerKey)) {
          const answer = input.agent?.ask
            ? yield* input.agent.ask({
                threadId: input.threadId,
                hostId: input.hostId,
                deviceId: input.deviceId,
                deviceName: device?.name ?? input.deviceId,
                hostLabel:
                  state.hosts.find((host) => host.id === input.hostId)?.label ?? input.hostId,
              })
            : "pending";
          if (answer === "pending") return yield* new DeviceAccessPendingError(refused);
          accessAnswers.set(answerKey, answer === "allowed");
        }
        if (!accessAnswers.get(answerKey)) {
          return yield* new DeviceAccessDeniedError({ ...refused, reason: "declined" });
        }
      }
    }
    if (input.intent === "open") {
      // A session a host leases to every thread is shared on purpose, and so is a delegation
      // tree's: the opener has to be an ancestor or a descendant of every thread already driving.
      const owner = launcherOwners.find(
        (bound) =>
          bound.hostId === input.hostId &&
          bound.deviceId === input.deviceId &&
          !sameLineage(bound.threadId, input.threadId) &&
          !hostSessionLaunchers.has(bound.session),
      );
      if (owner) {
        return yield* new DeviceInUseError({
          ...refused,
          threadId: owner.threadId,
          ...(owner.threadTitle === undefined ? {} : { threadTitle: owner.threadTitle }),
        });
      }
    }
    const hold = holds.get(holdKey(input.hostId, input.deviceId));
    if (hold && input.intent !== "read") {
      return yield* new DeviceHeldError({ ...refused, since: hold.since });
    }
    if (input.intent === "open" && device && isLocalCapture(device)) {
      // Signing is read now: the listing's answer is stale once the user saves a Team ID.
      const issues = [
        ...(device.issues ?? []).filter((issue) => issue.reason !== "signing_missing"),
        ...(device.platform === "ios" && !deviceSettings.signingReady
          ? [{ reason: "signing_missing" as const }]
          : []),
      ];
      const blocking = deviceIssueBlocks(issues, "control");
      if (blocking) return yield* new DeviceNotReadyError({ ...refused, ...blocking });
    }
  });

  /** Agents drive this computer with computer use, never through device tools. */
  const refuseDesktop = (
    operation: string,
    device: { readonly hostId: string; readonly id: string },
  ) =>
    isDesktopDevice(device)
      ? Effect.fail(
          new DeviceActionUnavailableError({
            operation,
            platform: "desktop",
            reason: "capture_device",
          }),
        )
      : Effect.void;

  const openCapture = Effect.fn("DeviceService.openCapture")(function* (
    input: DeviceOpenInput,
    device: DeviceSummary,
    context: { readonly agent?: DeviceAgentCaller | undefined } | undefined,
  ) {
    if (!(yield* readDeviceSettings).enabled)
      return yield* new DeviceHostUnavailableError({
        hostId: LOCAL_DEVICE_HOST_ID,
        hostLabel: LOCAL_DEVICE_HOST_LABEL,
        reason:
          "Device support is off. Enable it in the Device panel before installing or starting device tools.",
      });
    if (context?.agent) {
      yield* refuseDesktop("open", device);
      yield* authorizeAgent({
        threadId: input.threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: device.id,
        intent: "open",
        agent: context.agent,
      });
    } else if (captures) {
      // The user's own open starts the video, so a missing permission or a locked phone shows now.
      yield* captures.start(device).pipe(Effect.tapError(() => refreshCaptures));
    }
    const session: DeviceSession = {
      threadId: input.threadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: device.id,
      platform: device.platform,
      openedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* lifecycleLock.withPermit(
      publish((current) => ({
        ...current,
        sessions: [
          ...current.sessions.filter((existing) => !isSession(session)(existing)),
          session,
        ],
      })),
    );
    return session;
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(
    function* (input, context) {
      if (captures && (input.hostId ?? LOCAL_DEVICE_HOST_ID) === LOCAL_DEVICE_HOST_ID) {
        const listed = findDevice(
          (yield* SynchronizedRef.get(stateRef)).state,
          LOCAL_DEVICE_HOST_ID,
          input.deviceId,
        );
        const capture =
          listed && isLocalCapture(listed)
            ? listed
            : !listed && (input.platform === "desktop" || input.platform === "ios")
              ? findDevice(yield* refreshCaptures, LOCAL_DEVICE_HOST_ID, input.deviceId)
              : undefined;
        if (capture && isLocalCapture(capture)) return yield* openCapture(input, capture, context);
        if (input.platform === "desktop")
          return yield* new DeviceNotFoundError({
            hostId: LOCAL_DEVICE_HOST_ID,
            deviceId: input.deviceId,
          });
      }
      const host = yield* resolveHost(input.hostId);
      yield* ensurePlatform(host, input.platform);
      const ready = yield* readiness(host.id);
      let state = yield* refresh(ready);
      let device = findDevice(state, host.id, input.deviceId);
      if (!device) {
        return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
      }
      if (context?.agent)
        yield* authorizeAgent({
          threadId: input.threadId,
          hostId: host.id,
          deviceId: device.id,
          intent: "open",
          agent: context.agent,
        });
      // Hosts that route their own streams never encode emulator video with serve-emu's ffmpeg.
      if (device.platform === "android" && !device.physical && !ready.upstream) {
        // Resolve the override on the device host the way its hub does.
        const encoders = yield* ready.run(ready.nodePath, [
          "-e",
          `const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);`,
        ]);
        if (encoders.code !== 0) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host's PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
        if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
      }
      if (!device.booted && input.boot !== false) {
        if (device.physical)
          return yield* new DeviceActionUnavailableError({
            operation: "boot",
            platform: device.platform,
            reason: "physical_device",
          });
        const booting = { ...device, threadId: input.threadId };
        yield* publish((current) => ({
          ...current,
          bootingDevices: [
            ...(current.bootingDevices ?? []).filter(
              (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
            ),
            booting,
          ],
        }));
        const bootedId = yield* ready.devices.boot(device, context).pipe(
          Effect.ensuring(
            publish((current) => ({
              ...current,
              bootingDevices: (current.bootingDevices ?? []).filter(
                (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
              ),
            })),
          ),
        );
        state = yield* refresh(ready);
        // Retained entries predate the boot, so only a complete listing confirms the booted device.
        device = state.hostStatuses[host.id]?.incompletePlatforms?.includes(device.platform)
          ? undefined
          : (findDevice(state, host.id, bootedId) ?? findDevice(state, host.id, device.id));
        if (!device) {
          return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: bootedId });
        }
      } else if (device.booted) {
        yield* ready.devices.attach(device);
      }
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      const session: DeviceSession = {
        threadId: input.threadId,
        hostId: host.id,
        deviceId: device.id,
        platform: device.platform,
        openedAt,
      };
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          if (!(yield* readDeviceSettings).enabled)
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              hostLabel: host.label,
              reason: "Device support was turned off while the device was opening.",
            });
          yield* publish((current) => ({
            ...current,
            sessions: [
              ...current.sessions.filter(
                (existing) =>
                  !(
                    existing.threadId === session.threadId &&
                    existing.hostId === session.hostId &&
                    existing.deviceId === session.deviceId
                  ),
              ),
              session,
            ],
          }));
        }),
      );
      return session;
    },
  );

  const refreshAfterShutdown = (ready: DeviceReadiness) =>
    refresh(ready).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Device discovery unavailable after shutdown", { cause }),
      ),
    );

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    ready: DeviceReadiness,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    yield* ready.devices.shutdown({ id: deviceId, platform });
    yield* publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.hostId === ready.hostId && device.id === deviceId
          ? { ...device, booted: false }
          : device,
      ),
    }));
  });

  const close: DeviceService["Service"]["close"] = Effect.fn("DeviceService.close")(
    function* (input) {
      // Open publishes under the same lock; an old close must not release a reopened claim.
      const closing = yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          const { state } = yield* SynchronizedRef.get(stateRef);
          const closing = state.sessions.filter(
            (session) =>
              session.threadId === input.threadId &&
              (input.hostId === undefined || session.hostId === input.hostId) &&
              (input.deviceId === undefined || session.deviceId === input.deviceId),
          );
          // A physical device has no power-off here, so closing one ends only this thread's session.
          const powersOff = (session: DeviceSession) =>
            input.shutdown === true &&
            findDevice(state, session.hostId, session.deviceId)?.physical !== true;
          const ending = state.sessions.filter(
            (session) =>
              closing.includes(session) ||
              closing.some(
                (closed) =>
                  powersOff(closed) &&
                  closed.hostId === session.hostId &&
                  closed.deviceId === session.deviceId,
              ),
          );
          const released: Array<{
            readonly session: DeviceSession;
            readonly release: DeviceHost.DeviceHostReady["releaseAgentSession"];
          }> = [];
          for (const session of ending) {
            const host = yield* resolveHost(session.hostId);
            const ready = yield* host.current;
            // A lost SSH tunnel does not establish that the remote daemon stopped.
            if (!ready && (yield* host.summary).kind === "ssh")
              return yield* new DeviceHostUnavailableError({
                hostId: session.hostId,
                hostLabel: host.label,
                reason: "Device host is reconnecting. Retry close after it reconnects.",
              });
            released.push({ session, release: ready?.releaseAgentSession });
          }
          // A thread of the same lineage that stays open keeps the agent-device session it shares.
          const endingNames = yield* endingSessionNames(ending);
          for (const [name, session] of endingNames) {
            const release = released.find((entry) => entry.session === session)?.release;
            if (release) yield* release(name, session.deviceId);
          }
          if (input.shutdown) yield* releaseLaunchers(ending);
          if (input.shutdown) {
            for (const session of closing.filter(powersOff)) {
              const ready = yield* currentReadiness(session.hostId);
              if (!ready)
                return yield* new DeviceHostUnavailableError({
                  hostId: session.hostId,
                  reason: "Device host is not running. Reconnect before retrying close.",
                });
              yield* shutdownDevice(ready, session.deviceId, session.platform);
            }
          }
          const next = yield* publish((current) => ({
            ...current,
            sessions: current.sessions.filter((session) => !ending.includes(session)),
          }));
          if (captures)
            yield* Effect.forEach(
              ending.filter(
                (session) =>
                  session.hostId === LOCAL_DEVICE_HOST_ID &&
                  !next.sessions.some(
                    (open) => open.hostId === session.hostId && open.deviceId === session.deviceId,
                  ) &&
                  next.devices.some(
                    (device) => device.id === session.deviceId && isLocalCapture(device),
                  ),
              ),
              (session) => captures.stop(session.deviceId),
              { discard: true },
            );
          return closing;
        }),
      );
      if (input.shutdown)
        yield* Effect.forEach(
          closing,
          (session) =>
            currentReadiness(session.hostId).pipe(
              Effect.flatMap((ready) => (ready ? refreshAfterShutdown(ready) : Effect.void)),
            ),
          { discard: true },
        );
    },
  );

  // Sessions retire before the power-off, while their agent-device sessions can still close the app;
  // agent-device keeps a claim whose app close fails.
  const shutdown: DeviceService["Service"]["shutdown"] = Effect.fn("DeviceService.shutdown")(
    function* (input) {
      const host = yield* resolveHost(input.hostId);
      const { state } = yield* SynchronizedRef.get(stateRef);
      if (findDevice(state, host.id, input.deviceId)?.physical)
        return yield* new DeviceActionUnavailableError({
          operation: "shutdown",
          platform: input.platform,
          reason: "physical_device",
        });
      yield* publish((current) => ({
        ...current,
        sessions: current.sessions.filter(
          (session) => !(session.hostId === host.id && session.deviceId === input.deviceId),
        ),
      }));
      const ready = yield* readiness(host.id);
      yield* shutdownDevice(ready, input.deviceId, input.platform);
      yield* refreshAfterShutdown(ready);
    },
  );

  const screenshot: DeviceService["Service"]["screenshot"] = Effect.fn("DeviceService.screenshot")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId, "screenshot");
      return { device, png: yield* ready.devices.screenshot(device) };
    },
  );

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (
    hostId: DeviceHostId | undefined,
    deviceId: DeviceId,
    operation: string,
  ) {
    const listed = findDevice(
      (yield* SynchronizedRef.get(stateRef)).state,
      hostId ?? LOCAL_DEVICE_HOST_ID,
      deviceId,
    );
    if (listed && isLocalCapture(listed))
      return yield* new DeviceActionUnavailableError({
        operation,
        platform: listed.platform,
        reason: "capture_device",
      });
    const host = yield* resolveHost(hostId);
    const ready = yield* readiness(host.id);
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device =
      findDevice(state, host.id, deviceId) ?? findDevice(yield* refresh(ready), host.id, deviceId);
    if (!device) return yield* new DeviceNotFoundError({ hostId: host.id, deviceId });
    return { ready, device };
  });

  const detail: DeviceService["Service"]["detail"] = Effect.fn("DeviceService.detail")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId, "settings");
      const read = yield* readDeviceDetail(ready, device.platform, device.id);
      return {
        hostId: ready.hostId,
        deviceId: device.id,
        settings: read.settings,
        foregroundApp: read.foregroundApp,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const action: DeviceService["Service"]["action"] = Effect.fn("DeviceService.action")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId, "settings");
      yield* runDeviceAction(ready, device.platform, input);
      return yield* detail({ hostId: ready.hostId, deviceId: device.id });
    },
  );

  const sessionsForThread: DeviceService["Service"]["sessionsForThread"] = (threadId) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map(({ state }) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  const locate = <T extends { readonly hostId: DeviceHostId }>(
    state: DeviceServiceState,
    input: { readonly hostId?: DeviceHostId | undefined; readonly deviceId: DeviceId },
    matches: ReadonlyArray<T>,
  ): Effect.Effect<Option.Option<T>, DeviceHostAmbiguousError | DeviceOnOtherHostError> => {
    const named = (id: DeviceHostId) => ({
      id,
      label: state.hosts.find((host) => host.id === id)?.label,
    });
    const onHost = matches.filter(
      (match) => input.hostId === undefined || match.hostId === input.hostId,
    );
    const hostIds = [...new Set(onHost.map((match) => match.hostId))];
    if (hostIds.length === 1) return Effect.succeedSome(onHost.at(-1)!);
    if (hostIds.length > 1) {
      return Effect.fail(
        new DeviceHostAmbiguousError({ deviceId: input.deviceId, hosts: hostIds.map(named) }),
      );
    }
    const elsewhere = [...new Set(matches.map((match) => match.hostId))];
    return input.hostId !== undefined && elsewhere.length > 0
      ? Effect.fail(
          new DeviceOnOtherHostError({
            deviceId: input.deviceId,
            host: named(input.hostId),
            hosts: elsewhere.map(named),
          }),
        )
      : Effect.succeedNone;
  };

  const locateDevice: DeviceService["Service"]["locateDevice"] = Effect.fn(
    "DeviceService.locateDevice",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    return yield* locate(
      state,
      input,
      state.devices.filter((device) => device.id === input.deviceId),
    );
  });

  const locateSession: DeviceService["Service"]["locateSession"] = Effect.fn(
    "DeviceService.locateSession",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    return yield* locate(
      state,
      input,
      state.sessions.filter(
        (session) => session.threadId === input.threadId && session.deviceId === input.deviceId,
      ),
    );
  });

  const startWifiPairing: DeviceService["Service"]["startWifiPairing"] = Effect.fn(
    "DeviceService.startWifiPairing",
  )(function* (input) {
    const host = yield* resolveHost(input.hostId);
    const { kind } = yield* host.summary;
    // Pairing runs the host machine's adb; cloud sessions and leased pools have no machine to pair with.
    if (kind !== "local" && kind !== "ssh")
      return yield* new DevicePlatformUnavailableError({
        hostId: host.id,
        platform: "android",
        reason: "Phones pair over Wi-Fi only with this machine or an SSH device host.",
      });
    const ready = yield* readiness(host.id);
    // Checked and claimed without yielding between, so two clients never start two attempts.
    if (pairing && !pairing.done) {
      if (pairing.requestId === input.requestId)
        return {
          attemptId: pairing.attemptId,
          qrPayload: pairing.qrPayload,
          state: (yield* SynchronizedRef.get(stateRef)).state,
        };
      return yield* new DeviceWifiPairingBusyError({
        hostId: pairing.hostId,
        attemptId: pairing.attemptId,
      });
    }
    const secret = AdbWifiPairing.newWifiPairingSecret();
    const attempt: NonNullable<typeof pairing> = {
      requestId: input.requestId,
      attemptId: secret.serviceName,
      hostId: ready.hostId,
      qrPayload: AdbWifiPairing.wifiPairingQrPayload(secret),
    };
    pairing = attempt;
    const base = { attemptId: attempt.attemptId, hostId: attempt.hostId };
    const current = () => pairing === attempt;
    const report = (wifiPairing: NonNullable<DeviceServiceState["wifiPairing"]>) =>
      Effect.suspend(() => {
        if (!current()) return Effect.void;
        if (wifiPairing.status === "connected" || wifiPairing.status === "failed")
          attempt.done = true;
        return publishPairing(wifiPairing);
      }).pipe(Effect.asVoid);
    const published = yield* publishPairing({ ...base, status: "waiting" });
    const fiber = yield* AdbWifiPairing.pairOverWifi(ready.run, secret, (status) =>
      report({ ...base, status }),
    ).pipe(
      Effect.flatMap((deviceId) =>
        report({ ...base, status: "connected", deviceId: DeviceId.make(deviceId) }).pipe(
          Effect.andThen(refresh(ready).pipe(Effect.ignore)),
        ),
      ),
      Effect.catchTags({
        WifiPairingFailed: (error) =>
          report({
            ...base,
            status: "failed",
            reason: error.reason,
            ...(error.detail ? { detail: error.detail } : {}),
          }),
      }),
      Effect.forkIn(pairingScope),
    );
    attempt.fiber = fiber;
    return { attemptId: attempt.attemptId, qrPayload: attempt.qrPayload, state: published };
  });

  const cancelWifiPairing: DeviceService["Service"]["cancelWifiPairing"] = Effect.fn(
    "DeviceService.cancelWifiPairing",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    if (pairing?.attemptId === input.attemptId) yield* endWifiPairing();
    return state.wifiPairing?.attemptId === input.attemptId
      ? yield* publishPairing(undefined)
      : state;
  });

  const forgetDevice: DeviceService["Service"]["forgetDevice"] = Effect.fn(
    "DeviceService.forgetDevice",
  )(function* (input) {
    const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device = findDevice(state, hostId, input.deviceId);
    if (!device) return yield* new DeviceNotFoundError({ hostId, deviceId: input.deviceId });
    if (device.connection !== "wifi")
      return yield* new DeviceActionUnavailableError({
        operation: "forget",
        platform: device.platform,
        reason: "not_wifi",
      });
    const ready = yield* readiness(hostId);
    for (const threadId of new Set(
      state.sessions
        .filter((session) => session.hostId === hostId && session.deviceId === device.id)
        .map((session) => session.threadId),
    ))
      yield* close({ threadId, hostId, deviceId: device.id, shutdown: false });
    yield* setHold({ hostId, deviceId: device.id, held: false });
    const result = yield* ready.run("adb", ["disconnect", device.id]);
    const said = `${result.stdout}\n${result.stderr}`;
    // "No such device" means adb already let it go, which is what forgetting asks for.
    if (result.code !== 0 && !/no such device|disconnected/i.test(said))
      return yield* new DeviceOperationError({
        operation: "forget",
        reason: "command_failed",
        exitCode: result.code,
        cause: said.trim(),
      });
    return yield* refresh(ready);
  });

  if (captures) {
    // An unplugged phone or a display that went away ends its capture; list again so it shows.
    const ended = yield* captures.ended;
    yield* PubSub.take(ended).pipe(
      Effect.andThen(refreshCaptures),
      Effect.ignore,
      Effect.forever,
      Effect.forkIn(pairingScope),
    );
  }

  // Sessions live in memory, so this removes every launcher a previous run left behind.
  yield* pruneLaunchers;
  // Holds live in memory too: a marker left behind would block agents with nothing to hand back.
  yield* launchers?.clearHolds ?? Effect.void;

  return {
    ...DeviceService.of({
      testHost,
      updateTool: Effect.fn("DeviceService.updateTool")(function (tool) {
        return lifecycleLock.withPermit(
          Effect.gen(function* () {
            if (!installTool)
              return yield* new DeviceOperationError({
                operation: "update device tool",
                reason: "request_failed",
                cause: new Error("Tool installation is unavailable in this device service."),
              });
            yield* installTool(tool);
            return yield* inspect;
          }),
        );
      }),
      retryHost,
      inspect,
      easAccount: Effect.fn("DeviceService.easAccount")(function () {
        return Effect.fail(
          new DeviceEasAccountError({
            reason: "EAS accounts are unavailable in this device service.",
          }),
        );
      }),
      simlockIdentity: Effect.fn("DeviceService.simlockIdentity")(function () {
        return Effect.fail(
          new DeviceSimlockIdentityError({
            reason: "Simlock hosts are unavailable in this device service.",
          }),
        );
      }),
      agentTarget: Effect.fn("DeviceService.agentTarget")(function* (input) {
        const host = yield* resolveHost(input.hostId);
        yield* refuseDesktop("open", { hostId: host.id, id: input.deviceId });
        yield* authorizeAgent({ ...input, intent: "open" });
        const ready = yield* agentReadinessIfSupported(input.hostId);
        if (!ready)
          return yield* new DeviceHostUnavailableError({
            hostId: host.id,
            hostLabel: host.label,
            reason:
              "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
          });
        const { configPath, agentDeviceId, boundSession, installDirectory } =
          yield* lifecycleLock.withPermit(
            Effect.gen(function* () {
              if (hosts.get(host.id) !== host)
                return yield* new DeviceHostUnavailableError({
                  hostId: host.id,
                  hostLabel: host.label,
                  reason: "Host configuration changed. Retry the operation.",
                });
              if (ready.devices.agentEndpoint) {
                const endpoint = yield* ready.devices.agentEndpoint(input.deviceId);
                return {
                  configPath: yield* configureAgent(input.hostId, endpoint, input.deviceId),
                  agentDeviceId: endpoint.agentDeviceId,
                  boundSession: endpoint.session,
                  installDirectory: endpoint.installDirectory,
                };
              }
              if (!ready.agentDevice)
                return yield* new DeviceHostUnavailableError({
                  hostId: host.id,
                  hostLabel: host.label,
                  reason: "This host has no agent-device daemon.",
                });
              return {
                configPath: yield* configureAgent(input.hostId, ready.agentDevice),
                agentDeviceId: input.deviceId,
                boundSession: undefined,
                installDirectory: undefined,
              };
            }),
          );
        const ownSession = yield* sessionName(input);
        if (boundSession) hostSessionLaunchers.add(ownSession);
        const session = boundSession ?? ownSession;
        return {
          agentDeviceId,
          session,
          args: ["--config", configPath, "--session", session],
          installDirectory,
        };
      }),
      agentLauncher: Effect.fn("DeviceService.agentLauncher")(function* ({
        targetArgs,
        agent,
        ...target
      }) {
        yield* authorizeAgent({ ...target, intent: "open", agent });
        if (!launchers)
          return yield* new DeviceHostUnavailableError({
            hostId: target.hostId,
            reason: "Agent launchers are unavailable in this device service.",
          });
        const session = yield* sessionName(target);
        return yield* launcherLock.withPermit(
          Effect.gen(function* () {
            const { state } = yield* SynchronizedRef.get(stateRef);
            if (!state.sessions.some(isSession(target))) return Option.none();
            const launcher = yield* launchers.bind({
              session,
              targetArgs,
              hostId: target.hostId,
              deviceId: target.deviceId,
            });
            boundLaunchers.set(session, launcher);
            launcherOwners = [
              ...launcherOwners.filter((owner) => !isSession(target)(owner)),
              { ...target, session, threadTitle: agent?.threadTitle },
            ];
            return Option.some(launcher);
          }),
        );
      }),
      state: SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state)),
      subscribe: PubSub.subscribe(statePubSub),
      configure,
      list,
      open,
      close,
      shutdown,
      authorizeAgent,
      setHold,
      holdOnInput,
      setAccess,
      startWifiPairing,
      cancelWifiPairing,
      forgetDevice,
      detail,
      action,
      screenshot,
      locateDevice,
      locateSession,
      readiness,
      readinessIfSupported,
      agentReadinessIfSupported,
      currentReadiness,
      // Runs for every proxied device request; the capture route is the span that matters.
      captureRoute: Effect.fnUntraced(function* (hostId, hubPath, search) {
        return captures && (hostId ?? LOCAL_DEVICE_HOST_ID) === LOCAL_DEVICE_HOST_ID
          ? yield* captures.route(hubPath, search)
          : null;
      }),
      sessionsForThread,
    }),
    setHostStatus,
    /** Follows a `deviceAccess` change made outside `setAccess`, such as a settings import. */
    refreshAccess: (access: DeviceAccessMap) =>
      SynchronizedRef.get(stateRef).pipe(
        Effect.flatMap(({ state }) =>
          JSON.stringify(state.access) === JSON.stringify(access)
            ? Effect.void
            : publishAccess(access),
        ),
      ),
    withLifecycleLock: lifecycleLock.withPermit,
    refreshHosts: Effect.gen(function* () {
      const summaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
      const unchanged = (id: DeviceHostId) =>
        hosts.has(id) && hosts.get(id) === publishedHosts.get(id);
      // An attempt on a host that was removed or replaced has no adb left to finish with.
      const pairingHost = wifiPairingHost();
      if (pairingHost !== undefined && !unchanged(pairingHost)) {
        yield* endWifiPairing();
        yield* publishPairing(undefined);
      }
      for (const [key, hold] of holds) {
        if (unchanged(hold.hostId)) continue;
        holds.delete(key);
        yield* launchers?.hold?.(hold, null) ?? Effect.void;
      }
      yield* publish((state) => ({
        ...state,
        holds: [...holds.values()],
        hosts: summaries,
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => unchanged(id)),
        ),
        devices: state.devices.filter((device) => unchanged(device.hostId)),
        sessions: state.sessions.filter((session) => unchanged(session.hostId)),
      }));
      publishedHosts = new Map(hosts);
    }),
  };
});

/** @public */
/** @public */
export const make = Effect.gen(function* () {
  const localHost = yield* DeviceHost.DeviceHost;
  // Optional so hosts-only tests need no capture source; `layer` always provides it.
  const captures = Option.getOrUndefined(
    yield* Effect.serviceOption(CaptureDevices.CaptureDevices),
  );
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const scope = yield* Scope.Scope;
  const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
    [localHost.id, localHost],
  ]);
  const digest = yield* Digest.Digest;
  const configPath = (hostId: DeviceHostId, deviceId?: DeviceId) =>
    agentDeviceConfigPath(config.stateDir, hostId, path, deviceId).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
  const configureAgent = Effect.fn("DeviceService.configureAgent")(
    function* (
      hostId: DeviceHostId,
      endpoint: DeviceHost.AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
      deviceId?: DeviceId,
    ) {
      const file = yield* configPath(hostId, deviceId);
      yield* writeAgentDeviceConfig(file, endpoint);
      return file;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({
          operation: "configure agent",
          reason: "settings_failed",
          cause,
        }),
    ),
  );
  const agentCli = resolveNodeExecutable("Device automation").pipe(
    Effect.andThen(ensureAgentDevice(config.baseDir)),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.map((tool) => tool.entryPath),
    Effect.mapError((error) =>
      error._tag === "NodeRuntimeUnavailableError"
        ? new DeviceHostUnavailableError({
            hostId: LOCAL_DEVICE_HOST_ID,
            hostLabel: LOCAL_DEVICE_HOST_LABEL,
            reason: nodeRuntimeUnavailableMessage("Device automation"),
            cause: error,
          })
        : new DeviceOperationError({
            operation: "install agent CLI",
            reason: "command_failed",
            cause: error,
          }),
    ),
  );
  const launchers: AgentDeviceLaunchers = {
    bind: Effect.fn("DeviceService.bindLauncher")(
      function* (input) {
        const entryPath = yield* agentCli;
        // The unbound launcher stays current for agents that still call it with flags.
        yield* ensureAgentDeviceShim({ entryPath, stateDir: config.stateDir });
        const holdName = yield* agentDeviceHoldName(input.hostId, input.deviceId).pipe(
          Effect.provideService(Digest.Digest, digest),
        );
        return yield* bindAgentDeviceLauncher({
          entryPath,
          stateDir: config.stateDir,
          session: input.session,
          targetArgs: input.targetArgs,
          holdMarker: agentDeviceHoldMarker(config.stateDir, holdName, path),
        });
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchTags({
        NodeRuntimeUnavailableError: (cause) =>
          Effect.fail(
            new DeviceHostUnavailableError({
              hostId: LOCAL_DEVICE_HOST_ID,
              hostLabel: LOCAL_DEVICE_HOST_LABEL,
              reason: nodeRuntimeUnavailableMessage("Device automation"),
              cause,
            }),
          ),
        PlatformError: (cause) =>
          Effect.fail(
            new DeviceHostUnavailableError({
              hostId: LOCAL_DEVICE_HOST_ID,
              hostLabel: LOCAL_DEVICE_HOST_LABEL,
              reason: "Could not prepare the agent-device launcher.",
              cause,
            }),
          ),
      }),
    ),
    prune: (live) =>
      pruneAgentDeviceLaunchers({ stateDir: config.stateDir, live }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    // The tools refuse a held device on their own; a failed marker only weakens the launcher check.
    hold: (device, message) =>
      agentDeviceHoldName(device.hostId, device.deviceId).pipe(
        Effect.provideService(Digest.Digest, digest),
        Effect.flatMap((name) => setAgentDeviceHold({ stateDir: config.stateDir, name, message })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catch((cause) =>
          Effect.logWarning("Could not update the device hold marker", { device, cause }),
        ),
      ),
    clearHolds: clearAgentDeviceHolds(config.stateDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.ignore,
    ),
    // Best effort: an unreachable host fails fast in the launcher's connection check, and the
    // launcher goes either way. Only a failed or timed-out close can leave the device claimed.
    release: (launcher) =>
      resolveNodeExecutable("Device automation").pipe(
        Effect.flatMap((node) =>
          runner.run({
            command: node,
            args: [path.join(path.dirname(launcher), "agent-device-launcher.mjs"), "close"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [AGENT_DEVICE_RELEASE_ENV]: "1" },
            timeout: "15 seconds",
            timeoutBehavior: "timedOutResult",
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.flatMap((result) => {
          const outcome = agentDeviceCloseOutcome(result);
          return outcome === "failed" || outcome === "timed-out"
            ? Effect.logWarning("Could not end the agent-device session", {
                launcher,
                outcome,
                stderr: result.stderr.slice(-500),
              })
            : Effect.void;
        }),
        Effect.tapError((cause) =>
          Effect.logWarning("Could not end the agent-device session", { launcher, cause }),
        ),
        Effect.ignore,
      ),
  };
  const probeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.probe>>>();
  const localTargetContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof isLocalSshDeviceHost>>>();
  const service = yield* makeWithHosts(
    hosts,
    (host) =>
      Effect.gen(function* () {
        if (yield* isLocalSshDeviceHost(host).pipe(Effect.provide(localTargetContext))) {
          return yield* localHost.summary;
        }
        return yield* SshDeviceHost.probe(host).pipe(Effect.provide(probeContext));
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "DeviceHostError" && SshDeviceHost.isSshWindowsHostError(error.cause)
            ? new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason: sshProbeFailureMessage(error),
                cause: error,
              })
            : new DeviceOperationError({
                operation: "probe host",
                reason: "request_failed",
                cause: error,
              }),
        ),
      ),
    configureAgent,
    (tool) =>
      (tool === "hub" ? ensureDeviceHub(config.baseDir) : ensureAgentDevice(config.baseDir)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "update device tool",
              reason: "command_failed",
              // Only the exit code goes into the shown message; npm's stderr can carry registry credentials.
              ...(cause.exitCode !== undefined ? { exitCode: cause.exitCode } : {}),
              cause,
            }),
        ),
      ),
    launchers,
    captures,
  );
  const hostContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.make>>>();
  const easContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof EasDeviceHost.make>>>();
  const simlockContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SimlockDeviceHost.make>>>();
  const simlockAgentCli = Effect.fn("DeviceService.simlockAgentCli")(
    function* (hostId: string) {
      const nodePath = yield* resolveNodeExecutable("Device automation");
      const tool = yield* ensureAgentDevice(config.baseDir).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId, step: "installing agent tools", cause }),
        ),
      );
      return { nodePath, entryPath: tool.entryPath };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const configured = new Map<string, { config: DeviceHostConfig; scope: Scope.Closeable }>();
  const unchanged = (current: DeviceHostConfig, previous: DeviceHostConfig) =>
    current.kind === "ssh" && previous.kind === "ssh"
      ? current.label === previous.label &&
        current.target === previous.target &&
        current.port === previous.port &&
        current.identityFile === previous.identityFile
      : JSON.stringify(current) === JSON.stringify(previous);
  const reconcile = Effect.fn("DeviceService.reconcile")(function* (
    configuredHosts: ReadonlyArray<DeviceHostConfig>,
  ) {
    const next = yield* remoteSshDeviceHosts(configuredHosts).pipe(
      Effect.provide(localTargetContext),
    );
    const removed = yield* service.withLifecycleLock(
      Effect.gen(function* () {
        const removed: Array<{ id: string; scope: Scope.Closeable }> = [];
        for (const [id, previous] of configured) {
          if (next.some((host) => host.id === id && unchanged(host, previous.config))) continue;
          hosts.delete(id);
          configured.delete(id);
          removed.push({ id, scope: previous.scope });
        }
        if (removed.length > 0) yield* service.refreshHosts;
        return removed;
      }),
    );
    // Stop old writers before deleting config files or publishing replacements, without blocking healthy hosts.
    yield* Effect.forEach(
      removed,
      ({ id, scope }) =>
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          yield* fs.remove(yield* configPath(id), { force: true }).pipe(Effect.ignore);
        }),
      { concurrency: 4, discard: true },
    );
    yield* service.withLifecycleLock(
      Effect.gen(function* () {
        let added = false;
        for (const host of next) {
          if (configured.has(host.id)) continue;
          added = true;
          const hostScope = yield* Scope.fork(scope);
          if (host.kind === "simlock") {
            // Closing this scope releases the host's leases back to the pool.
            const instance = yield* SimlockDeviceHost.make(host, simlockAgentCli(host.id)).pipe(
              Effect.provideService(Scope.Scope, hostScope),
              Effect.provide(simlockContext),
            );
            hosts.set(host.id, instance);
            configured.set(host.id, { config: host, scope: hostScope });
            // Ask the gateway now, so a refused token shows in Settings before anyone opens a device.
            if ((yield* settings.getSettings).enableDeviceSupport)
              yield* instance
                .platformAvailability("ios")
                .pipe(
                  Effect.andThen(service.withLifecycleLock(service.refreshHosts)),
                  Effect.forkIn(hostScope),
                );
            continue;
          }
          if (host.kind === "eas") {
            // Closing this scope stops the host's running sessions, so a changed
            // limit or token never leaves a billed session behind.
            const instance = yield* EasDeviceHost.make(host).pipe(
              Effect.provideService(Scope.Scope, hostScope),
              Effect.provide(easContext),
            );
            hosts.set(host.id, instance);
            configured.set(host.id, { config: host, scope: hostScope });
            continue;
          }
          const instance = yield* SshDeviceHost.make(
            host,
            (ready) =>
              (ready.agentDevice
                ? configureAgent(host.id, ready.agentDevice).pipe(Effect.asVoid)
                : Effect.void
              ).pipe(
                Effect.mapError(
                  (error) =>
                    new DeviceHost.DeviceHostError({
                      hostId: host.id,
                      step: "configuring agent access",
                      cause: error,
                    }),
                ),
              ),
            (status, detail) =>
              service
                .setHostStatus(host.id, { status, ...(detail ? { detail } : {}) })
                .pipe(Effect.asVoid),
          ).pipe(Effect.provideService(Scope.Scope, hostScope), Effect.provide(hostContext));
          hosts.set(host.id, instance);
          configured.set(host.id, { config: host, scope: hostScope });
        }
        // Refresh again after removed scopes closed so a late status write from an old host cannot linger.
        if (added || removed.length > 0) yield* service.refreshHosts;
      }),
    );
  });
  const changes = yield* settings.subscribeChanges;
  // Each kind has its own settings list; an id two lists share stays the first one's.
  const configuredHosts = (value: {
    readonly deviceHosts: ReadonlyArray<SshDeviceHostConfig>;
    readonly easDeviceHosts: ReadonlyArray<EasDeviceHostConfig>;
    readonly simlockDeviceHosts: ReadonlyArray<SimlockDeviceHostConfig>;
    readonly simlockDeviceHostsEnabled: boolean;
  }): ReadonlyArray<DeviceHostConfig> => {
    const hosts: Array<DeviceHostConfig> = [...value.deviceHosts];
    for (const host of [
      ...value.easDeviceHosts,
      ...(value.simlockDeviceHostsEnabled ? value.simlockDeviceHosts : []),
    ]) {
      if (!hosts.some((existing) => existing.id === host.id)) hosts.push(host);
    }
    return hosts;
  };
  const startingSettings = yield* settings.getSettings;
  yield* reconcile(configuredHosts(startingSettings));
  // The agent-device daemon reads its iOS signing from its own environment when it starts.
  const signingKey = (value: {
    readonly appleTeamId: string;
    readonly appleRunnerBundleId: string;
  }) => JSON.stringify(LocalDeviceHost.appleSigningEnvironment(value));
  let signing = signingKey(startingSettings);
  yield* changes.pipe(
    Stream.runForEach((value) =>
      Effect.gen(function* () {
        yield* reconcile(configuredHosts(value));
        yield* service.refreshAccess(value.deviceAccess);
        const next = signingKey(value);
        if (next === signing) return;
        signing = next;
        yield* localHost.stopAgent;
        yield* service.list.pipe(Effect.ignore);
      }),
    ),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(configured.values(), (value) => Scope.close(value.scope, Exit.void), {
      discard: true,
      concurrency: 4,
    }),
  );
  const easAccount: DeviceService["Service"]["easAccount"] = Effect.fn("DeviceService.easAccount")(
    function* (input) {
      const saved =
        input.hostId === undefined
          ? ""
          : ((yield* settings.getSettings).easDeviceHosts.find((host) => host.id === input.hostId)
              ?.accessToken ?? "");
      const credential = yield* EasDeviceHost.resolveSavedExpoCredential(
        secrets,
        input.accessToken ?? saved,
      );
      const viewer = yield* makeExpoApi(yield* HttpClient.HttpClient, credential).viewer;
      return { signedInAs: viewer.name, credentialSource: credential.source, apps: viewer.apps };
    },
    Effect.provide(easContext),
    // Only bounded text reaches the browser: the credential errors' own
    // guidance, or a category for what Expo answered, never Expo's text.
    Effect.mapError(
      (cause) =>
        new DeviceEasAccountError({
          reason:
            cause._tag === "ExpoApiError"
              ? cause.status === 401 || cause.status === 403
                ? `Expo rejected the credential (HTTP ${cause.status}).`
                : cause.rejected
                  ? "Expo refused the account check."
                  : "Could not complete the Expo account check."
              : cause.message,
        }),
    ),
  );

  const simlockIdentity: DeviceService["Service"]["simlockIdentity"] = Effect.fn(
    "DeviceService.simlockIdentity",
  )(
    function* (input) {
      const environment = yield* HostProcess.Environment;
      const gatewayUrl = (
        input.gatewayUrl || SimlockDeviceHost.machineSimlockToken(environment)?.gatewayUrl
      )?.replace(/\/$/, "");
      if (!gatewayUrl)
        return yield* new DeviceSimlockIdentityError({
          reason: "This machine's agent-device does not point at a Simlock gateway.",
        });
      const savedHost =
        input.hostId === undefined
          ? undefined
          : (yield* settings.getSettings).simlockDeviceHosts.find(
              (host) => host.id === input.hostId,
            );
      const token = input.agentToken
        ? {
            agentToken: yield* requireSettingsSecret(secrets, input.agentToken),
            source: "entered" as const,
          }
        : yield* SimlockDeviceHost.resolveSimlockToken(secrets, gatewayUrl, savedHost, environment);
      if (!token)
        return yield* new DeviceSimlockIdentityError({
          reason: savedHost?.agentToken
            ? "The saved token is for another gateway. Enter one for this gateway."
            : "No agent token for this gateway on this machine.",
        });
      const identity = yield* SimlockDeviceHost.simlockIdentity(gatewayUrl, token.agentToken).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceSimlockIdentityError({
              reason: SimlockDeviceHost.describeGatewayFailure(
                cause,
                gatewayUrl,
                token.source === "env" ? "this machine" : "this environment",
              ),
            }),
        ),
      );
      if (identity.role !== "agent")
        return yield* new DeviceSimlockIdentityError({
          reason: `That is a ${identity.role} token. Create one with --role agent.`,
        });
      return { gatewayUrl, signedInAs: identity.name, tokenSource: token.source };
    },
    Effect.catchTags({
      ServerSettingsError: () =>
        Effect.fail(new DeviceSimlockIdentityError({ reason: "Could not read the saved token." })),
      SettingsSecretUnresolvedError: (error) =>
        Effect.fail(new DeviceSimlockIdentityError({ reason: error.message })),
    }),
    Effect.provide(simlockContext),
  );

  return {
    ...service,
    easAccount,
    simlockIdentity,
  };
});

export const layer = Layer.effect(DeviceService, make).pipe(
  Layer.provide(LocalDeviceHost.layer),
  Layer.provide(CaptureDevices.layer.pipe(Layer.provide(MacVideoCapture.layer))),
  Layer.provide(SecretResolverLayer.layer),
);

export const stateStream = (service: DeviceService["Service"]): Stream.Stream<DeviceServiceState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading so no change is lost.
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);
