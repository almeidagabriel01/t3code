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
  DeviceNotFoundError,
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
  type DeviceAnswerLinkRequestInput,
  type DeviceLinkRequest,
  type DeviceSetLinkBlockedInput,
  isLinkedDeviceHostId,
  linkedDeviceHostId,
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
import * as Deferred from "effect/Deferred";
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
import * as LinkedDeviceHost from "./LinkedDeviceHost.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";

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
  /**
   * A linked environment acting here. Its thread ids carry its link's prefix, and an "Ask first"
   * device asks this environment's user through a link request instead of `ask`.
   */
  readonly link?: DeviceLink | undefined;
}

/** A linked environment's session here, and the label its owner paired it under. */
export interface DeviceLink {
  readonly linkId: string;
  readonly label: string;
}

/** How a linked environment's threads are named here: no thread of this one or another link's matches. */
export const linkedThreadId = (link: Pick<DeviceLink, "linkId">, threadId: string) =>
  `linked:${link.linkId}:${threadId}` as ThreadId;

/**
 * How long a linked agent's "Ask first" call waits for an answer before reporting it pending.
 * Under T3 Connect's ~100 s idle cut; the request stays answerable after it.
 */
const LINK_ANSWER_WAIT = "60 seconds";

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
      link?: DeviceLink,
    ) => Effect.Effect<void>;
    /**
     * A linked environment's user takes a device here over or hands it back. A hand back releases
     * only that link's own hold, never this environment's user's or another link's.
     */
    readonly setLinkedHold: (input: {
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly held: boolean;
      readonly link: DeviceLink;
    }) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** Which link holds a device, when a linked environment's user does. */
    readonly holdLink: (
      hostId: DeviceHostId,
      deviceId: DeviceId,
    ) => Effect.Effect<string | undefined>;
    /** Answers a linked environment's ask for an "Ask first" device, for its thread lineage. */
    readonly answerLinkRequest: (
      input: DeviceAnswerLinkRequestInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** Refuses a linked environment every device, ending what it has open, or lets it back in. */
    readonly setLinkBlocked: (
      input: DeviceSetLinkBlockedInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    /** Records that a link used devices here, so the owner can see and block it. */
    readonly noteLinkClient: (link: DeviceLink) => Effect.Effect<void>;
    /**
     * Binds a linked agent to a device its thread opened here: the daemon to forward its
     * agent-device calls to, and the session this side names for its lineage.
     */
    readonly bindLinkedAgent: (input: {
      readonly threadId: ThreadId;
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly agent: DeviceAgentCaller;
    }) => Effect.Effect<
      {
        readonly daemon: DeviceHost.AgentDaemonEndpoint;
        readonly session: string;
        readonly agentDeviceId: string;
      },
      DeviceError
    >;
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
      context?: DeviceHost.DeviceOpenContext & {
        readonly agent?: DeviceAgentCaller | undefined;
        /** A linked environment opening it, which its session then names. */
        readonly link?: (DeviceLink & { readonly threadTitle?: string | undefined }) | undefined;
      },
    ) => Effect.Effect<DeviceSession, DeviceError>;
    readonly close: (input: DeviceCloseInput) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
    readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly screenshot: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
      /** The thread looking, which a host on another environment checks there. */
      readonly threadId?: ThreadId | undefined;
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
    readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
    /**
     * Where a local launcher's agent-device call for a linked device goes: that environment's
     * agent route with the link's token. None for an unknown host or a token it never issued.
     */
    readonly linkedAgentUpstream: (
      hostId: string,
      token: string,
      path: string,
    ) => Effect.Effect<Option.Option<DeviceHost.HubUpstream>, DeviceError>;
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

/** Hosts built without linked environments have no tunnel to route a launcher through. */
const noLinkedUpstream: DeviceService["Service"]["linkedAgentUpstream"] = () => Effect.succeedNone;

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
  /** Brings hosts that come and go outside settings, such as linked environments', up to date. */
  beforeList: Effect.Effect<void> = Effect.void,
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
      supportsLinkedDevices: true,
      linkRequests: [],
      linkClients: [],
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
  /** Which link holds a device, by `holdKey`; a hold without an entry is this environment's user's. */
  const holdLinks = new Map<string, string>();
  /** Links that used devices here since startup, by link id. */
  const seenLinks = new Map<string, string>();
  /** Linked agents waiting on this user for an "Ask first" device, by answer key. */
  const linkRequests = new Map<
    string,
    {
      readonly request: DeviceLinkRequest;
      readonly linkId: string;
      readonly answer: Deferred.Deferred<boolean>;
    }
  >();
  let linkRequestCount = 0;
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
    const reportedHolds = ready.devices.holds ? yield* ready.devices.holds : undefined;
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled || !host || hosts.get(ready.hostId) !== host)
          return (yield* SynchronizedRef.get(stateRef)).state;
        if (detail && (incompletePlatforms.length > 0 || androidDiscoveryIncomplete))
          discoveryDetails.set(ready.hostId, detail);
        else discoveryDetails.delete(ready.hostId);
        if (reportedHolds) {
          for (const [key, hold] of holds) if (hold.hostId === ready.hostId) holds.delete(key);
          for (const hold of reportedHolds) {
            const deviceId = hold.deviceId as DeviceId;
            holds.set(holdKey(ready.hostId, deviceId), { ...hold, hostId: ready.hostId, deviceId });
          }
        }
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(reportedHolds ? { holds: [...holds.values()] } : {}),
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter(
              (device) =>
                device.hostId !== ready.hostId || incompletePlatforms.includes(device.platform),
            ),
            ...devices.filter((device) => !incompletePlatforms.includes(device.platform)),
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

  /** A host whose listing failed, with its summary again: a linked host's names why. */
  const hostFailed = Effect.fn("DeviceService.hostFailed")(function* (
    hostId: DeviceHostId,
    error: DeviceError | DeviceHost.DeviceHostError,
  ) {
    const host = hosts.get(hostId);
    if (host) {
      const summary = yield* host.summary;
      yield* publish((state) => ({
        ...state,
        hosts: state.hosts.map((value) => (value.id === hostId ? summary : value)),
      }));
    }
    return yield* setHostStatus(hostId, {
      status: "failed",
      detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
    });
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    yield* beforeList;
    if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const ready = yield* readinessIfSupported(host.id);
          if (ready) yield* refresh(ready);
        }).pipe(Effect.catch((error) => hostFailed(host.id, error))),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

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
      }).pipe(Effect.catch((error) => hostFailed(hostId, error)));
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

  const changeHold = Effect.fn("DeviceService.changeHold")(function* (
    input: DeviceSetHoldInput,
    link?: DeviceLink,
  ) {
    const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
    const key = holdKey(hostId, input.deviceId);
    const since = DateTime.formatIso(yield* DateTime.now);
    const { state } = yield* SynchronizedRef.get(stateRef);
    // Checked and changed without yielding between, so a repeat never publishes twice.
    if (holds.has(key) === input.held) return state;
    // A link hands back only its own hold; the owner's and other links' stay.
    if (!input.held && link && holdLinks.get(key) !== link.linkId) return state;
    const device = findDevice(state, hostId, input.deviceId);
    if (input.held && !device) {
      return yield* new DeviceNotFoundError({ hostId, deviceId: input.deviceId });
    }
    const target = { hostId, deviceId: input.deviceId };
    // A linked environment's device is held there, where its agents and that owner's see it.
    if (!link && isLinkedDeviceHostId(hostId)) {
      const ready = yield* currentReadiness(hostId);
      yield* ready?.devices.setHold?.(input.deviceId, input.held) ?? Effect.void;
    }
    if (input.held) {
      holds.set(key, { ...target, since, ...(link ? { linked: { label: link.label } } : {}) });
      if (link) holdLinks.set(key, link.linkId);
    } else {
      holds.delete(key);
      holdLinks.delete(key);
    }
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
  });

  const setHold: DeviceService["Service"]["setHold"] = (input) => changeHold(input);

  const setLinkedHold: DeviceService["Service"]["setLinkedHold"] = ({ link, ...input }) =>
    changeHold(input, link);

  const holdLink: DeviceService["Service"]["holdLink"] = (hostId, deviceId) =>
    Effect.sync(() => holdLinks.get(holdKey(hostId, deviceId)));

  // Runs for every input frame, so a held device costs one map lookup and no span.
  const holdOnInput: DeviceService["Service"]["holdOnInput"] = (hostId, deviceId, link) =>
    Effect.suspend(() =>
      holds.has(holdKey(hostId ?? LOCAL_DEVICE_HOST_ID, deviceId))
        ? Effect.void
        : changeHold({ hostId, deviceId, held: true }, link).pipe(Effect.ignore),
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

  const publishLinkRequests = publish((state) => ({
    ...state,
    linkRequests: [...linkRequests.values()].map((entry) => entry.request),
  }));

  /**
   * A linked agent's ask waits on this environment's user, in the Device panel and Settings,
   * since a decision needs a thread and project here. One request per lineage and device:
   * a repeat waits on the same one, and the answer is kept like a decision's.
   */
  const askLink = Effect.fn("DeviceService.askLink")(function* (
    link: DeviceLink,
    answerKey: string,
    question: DeviceAccessQuestion,
    threadTitle: string | undefined,
  ) {
    let entry = linkRequests.get(answerKey);
    if (!entry) {
      linkRequestCount += 1;
      entry = {
        linkId: link.linkId,
        answer: yield* Deferred.make<boolean>(),
        request: {
          requestId: `link-request-${linkRequestCount}`,
          linkLabel: link.label,
          ...(threadTitle === undefined ? {} : { threadTitle }),
          hostId: question.hostId,
          deviceId: question.deviceId,
          deviceName: question.deviceName,
        },
      };
      linkRequests.set(answerKey, entry);
      yield* publishLinkRequests;
    }
    const answered = yield* Deferred.await(entry.answer).pipe(
      Effect.timeoutOption(LINK_ANSWER_WAIT),
    );
    return Option.isNone(answered)
      ? ("pending" as const)
      : answered.value
        ? ("allowed" as const)
        : ("declined" as const);
  });

  const settleLinkRequests = Effect.fnUntraced(function* (
    matches: (entry: { readonly request: DeviceLinkRequest; readonly linkId: string }) => boolean,
    allow: boolean,
  ) {
    const settled = [...linkRequests].filter(([, entry]) => matches(entry));
    for (const [answerKey, entry] of settled) {
      linkRequests.delete(answerKey);
      accessAnswers.set(answerKey, allow);
      yield* Deferred.succeed(entry.answer, allow);
    }
    return settled.length;
  });

  const answerLinkRequest: DeviceService["Service"]["answerLinkRequest"] = Effect.fn(
    "DeviceService.answerLinkRequest",
  )(function* (input) {
    // An answer that arrives after another client's is the same answer: nothing is left to settle.
    yield* settleLinkRequests((entry) => entry.request.requestId === input.requestId, input.allow);
    return yield* publishLinkRequests;
  });

  const publishLinkClients = Effect.fnUntraced(function* () {
    const blocked = (yield* settings.getSettings.pipe(
      Effect.map((value) => value.deviceBlockedLinks),
      Effect.orElseSucceed(() => []),
    )) as ReadonlyArray<{ readonly linkId: string; readonly label: string }>;
    const clients = new Map<string, { linkId: string; label: string; blocked: boolean }>();
    for (const [linkId, label] of seenLinks) clients.set(linkId, { linkId, label, blocked: false });
    for (const entry of blocked) clients.set(entry.linkId, { ...entry, blocked: true });
    return yield* publish((state) => ({ ...state, linkClients: [...clients.values()] }));
  });

  const noteLinkClient: DeviceService["Service"]["noteLinkClient"] = (link) =>
    Effect.suspend(() => {
      if (seenLinks.get(link.linkId) === link.label) return Effect.void;
      seenLinks.set(link.linkId, link.label);
      return publishLinkClients().pipe(Effect.asVoid);
    });

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
    // Ending a session is not using the device, so a policy never keeps one open. A linked
    // environment's device answers to its owner's policy there, not to one stored here.
    if (input.intent !== "close" && !isLinkedDeviceHostId(input.hostId)) {
      const subject = device ?? { hostId: input.hostId, id: input.deviceId, physical: false };
      const policy = deviceAccessPolicy((yield* readDeviceSettings).access, subject);
      if (policy === "deny") {
        return yield* new DeviceAccessDeniedError({ ...refused, reason: "policy" });
      }
      if (policy === "ask") {
        const answerKey = `${lineageRoot(input.threadId)}\u0000${deviceAccessKey(subject)}`;
        if (!accessAnswers.has(answerKey)) {
          const question = {
            threadId: input.threadId,
            hostId: input.hostId,
            deviceId: input.deviceId,
            deviceName: device?.name ?? input.deviceId,
            hostLabel: state.hosts.find((host) => host.id === input.hostId)?.label ?? input.hostId,
          };
          const link = input.agent?.link;
          const answer = link
            ? yield* askLink(link, answerKey, question, input.agent?.threadTitle)
            : input.agent?.ask
              ? yield* input.agent.ask(question)
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
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(
    function* (input, context) {
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
      // A host on another environment opens there for this thread, which that side checks.
      const hostContext: DeviceHost.DeviceOpenContext = {
        ...(context?.workspaceRoot === undefined ? {} : { workspaceRoot: context.workspaceRoot }),
        thread: {
          threadId: input.threadId,
          title: context?.agent?.threadTitle,
          ancestors: context?.agent?.ancestors,
          agent: context?.agent !== undefined,
        },
      };
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
        const bootedId = yield* ready.devices.boot(device, hostContext).pipe(
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
        yield* ready.devices.attach(device, hostContext);
      }
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      const linked = context?.link;
      const session: DeviceSession = {
        threadId: input.threadId,
        hostId: host.id,
        deviceId: device.id,
        platform: device.platform,
        openedAt,
        ...(linked
          ? {
              linked: {
                label: linked.label,
                ...(linked.threadTitle === undefined ? {} : { threadTitle: linked.threadTitle }),
              },
            }
          : {}),
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
          // A linked environment's device powers off there, under its owner's rules.
          const powersOff = (session: DeviceSession) =>
            input.shutdown === true &&
            !isLinkedDeviceHostId(session.hostId) &&
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
          yield* publish((current) => ({
            ...current,
            sessions: current.sessions.filter((session) => !ending.includes(session)),
          }));
          return closing;
        }),
      );
      // Outside the lock: the other environment may be slow or gone, and this side's close stands.
      yield* Effect.forEach(
        closing,
        (session) =>
          currentReadiness(session.hostId).pipe(
            Effect.flatMap(
              (ready) =>
                ready?.devices.closeSession?.({
                  threadId: session.threadId,
                  deviceId: session.deviceId,
                  shutdown: input.shutdown === true,
                }) ?? Effect.void,
            ),
            Effect.catch((cause) =>
              Effect.logWarning("Could not end the device session on the linked environment", {
                hostId: session.hostId,
                deviceId: session.deviceId,
                cause,
              }),
            ),
          ),
        { discard: true },
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
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      const png = yield* ready.devices.screenshot(
        device,
        input.threadId === undefined
          ? undefined
          : {
              thread: {
                threadId: input.threadId,
                ancestors: lineages.get(input.threadId),
                agent: true,
              },
            },
      );
      return { device, png };
    },
  );

  const bindLinkedAgent: DeviceService["Service"]["bindLinkedAgent"] = Effect.fn(
    "DeviceService.bindLinkedAgent",
  )(function* ({ agent, ...target }) {
    yield* authorizeAgent({ ...target, intent: "open", agent });
    const ready = yield* agentReadinessIfSupported(target.hostId);
    if (!ready)
      return yield* new DeviceHostUnavailableError({
        hostId: target.hostId,
        reason: "Agents cannot use devices on this environment: its owner has agent access off.",
      });
    const endpoint = ready.devices.agentEndpoint
      ? yield* ready.devices.agentEndpoint(target.deviceId)
      : ready.agentDevice;
    if (!endpoint)
      return yield* new DeviceHostUnavailableError({
        hostId: target.hostId,
        reason: "This host has no agent-device daemon.",
      });
    const session = yield* sessionName(target);
    const bound = yield* launcherLock.withPermit(
      Effect.gen(function* () {
        const { state } = yield* SynchronizedRef.get(stateRef);
        if (!state.sessions.some(isSession(target))) return false;
        // The linked side holds the launcher; owning the session here is what the in-use rule reads.
        launcherOwners = [
          ...launcherOwners.filter((owner) => !isSession(target)(owner)),
          { ...target, session, threadTitle: agent.threadTitle },
        ];
        return true;
      }),
    );
    if (!bound)
      return yield* new DeviceHostUnavailableError({
        hostId: target.hostId,
        reason: "The device closed before agent access was ready. Call device_open again.",
      });
    return {
      daemon: { baseUrl: endpoint.baseUrl, token: endpoint.token },
      session,
      agentDeviceId:
        "agentDeviceId" in endpoint && typeof endpoint.agentDeviceId === "string"
          ? endpoint.agentDeviceId
          : target.deviceId,
    };
  });

  const setLinkBlocked: DeviceService["Service"]["setLinkBlocked"] = Effect.fn(
    "DeviceService.setLinkBlocked",
  )(function* (input) {
    const label = input.label ?? seenLinks.get(input.linkId) ?? input.linkId;
    yield* accessLock.withPermit(
      Effect.gen(function* () {
        const current = (yield* settings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "block link",
                reason: "settings_failed",
                cause,
              }),
          ),
        )).deviceBlockedLinks;
        const rest = current.filter((entry) => entry.linkId !== input.linkId);
        yield* settings
          .updateSettings({
            deviceBlockedLinks: input.blocked ? [...rest, { linkId: input.linkId, label }] : rest,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new DeviceOperationError({
                  operation: "block link",
                  reason: "settings_failed",
                  cause,
                }),
            ),
          );
      }),
    );
    if (input.blocked) {
      // Its waiting agents hear no, its hand-held devices come back, and what it opened closes.
      yield* settleLinkRequests((entry) => entry.linkId === input.linkId, false);
      yield* publishLinkRequests;
      for (const [key, linkId] of holdLinks) {
        const hold = holds.get(key);
        if (linkId === input.linkId && hold)
          yield* changeHold({ hostId: hold.hostId, deviceId: hold.deviceId, held: false });
      }
      const prefix = linkedThreadId({ linkId: input.linkId }, "");
      const threads = new Set(
        (yield* SynchronizedRef.get(stateRef)).state.sessions
          .filter((session) => session.threadId.startsWith(prefix))
          .map((session) => session.threadId),
      );
      yield* Effect.forEach(threads, (threadId) => close({ threadId }).pipe(Effect.ignore), {
        discard: true,
      });
    }
    return yield* publishLinkClients();
  });

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (
    hostId: DeviceHostId | undefined,
    deviceId: DeviceId,
  ) {
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
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
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
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
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
                const endpoint = yield* ready.devices.agentEndpoint(input.deviceId, {
                  threadId: input.threadId,
                  title: input.agent?.threadTitle,
                  ancestors: input.agent?.ancestors,
                  agent: true,
                });
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
      setLinkedHold,
      holdLink,
      answerLinkRequest,
      setLinkBlocked,
      noteLinkClient,
      bindLinkedAgent,
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
      sessionsForThread,
      linkedAgentUpstream: noLinkedUpstream,
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
        holdLinks.delete(key);
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
  const peerLinks = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const linkedHosts = new Map<DeviceHostId, LinkedDeviceHost.LinkedDeviceHost>();
  const linkedContext = yield* Effect.context<HttpClient.HttpClient | SecureRandom.SecureRandom>();
  // Local launchers reach this server over loopback, which a wildcard bind always answers on.
  const localOrigin = `http://${
    config.host === undefined || config.host === "0.0.0.0" || config.host === "::"
      ? "127.0.0.1"
      : config.host.includes(":")
        ? `[${config.host}]`
        : config.host
  }:${config.port}`;
  // Annotated: it and `service` refer to each other through `beforeList`.
  const reconcileLinked: Effect.Effect<void> = Effect.gen(function* () {
    if (Option.isNone(peerLinks)) return;
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isNone(current)) return;
    const { enableDeviceSupport, linkedEnvironmentsEnabled, hiddenLinkedDeviceSources } =
      current.value;
    const wanted =
      enableDeviceSupport && linkedEnvironmentsEnabled
        ? (yield* peerLinks.value.stored.pipe(Effect.orElseSucceed(() => []))).filter(
            (link) => !hiddenLinkedDeviceSources.includes(link.environmentId),
          )
        : [];
    const wantedIds = new Set(wanted.map((link) => linkedDeviceHostId(link.environmentId)));
    if (wantedIds.size === linkedHosts.size && [...wantedIds].every((id) => linkedHosts.has(id)))
      return;
    const sessions = (yield* service.state).sessions;
    const ending = yield* service.withLifecycleLock(
      Effect.gen(function* () {
        const ending: Array<Effect.Effect<void, DeviceError>> = [];
        for (const [id, host] of linkedHosts) {
          if (wantedIds.has(id)) continue;
          // Its sessions there would otherwise stay open in the owner's panel.
          const closeSession = (yield* host.current)?.devices.closeSession;
          for (const session of sessions)
            if (session.hostId === id && closeSession)
              ending.push(
                closeSession({
                  threadId: session.threadId,
                  deviceId: session.deviceId,
                  shutdown: false,
                }),
              );
          yield* host.stop;
          linkedHosts.delete(id);
          hosts.delete(id);
        }
        for (const link of wanted) {
          const id = linkedDeviceHostId(link.environmentId);
          if (linkedHosts.has(id)) continue;
          const host = yield* LinkedDeviceHost.make({
            link: {
              environmentId: link.environmentId,
              label: link.label,
              resolve: peerLinks.value.resolve(link.environmentId),
              recordOutcome: (outcome) =>
                peerLinks.value.recordOutcome(link.environmentId, outcome),
            },
            localOrigin,
          }).pipe(Effect.provide(linkedContext));
          linkedHosts.set(id, host);
          hosts.set(id, host);
        }
        yield* service.refreshHosts;
        return ending;
      }),
    );
    yield* Effect.forEach(
      ending,
      (close) => close.pipe(Effect.timeout("10 seconds"), Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );
  });
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
    Effect.suspend(() => reconcileLinked),
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
  yield* reconcile(configuredHosts(yield* settings.getSettings));
  yield* reconcileLinked;
  yield* changes.pipe(
    Stream.runForEach((value) =>
      reconcile(configuredHosts(value)).pipe(
        Effect.andThen(reconcileLinked),
        Effect.andThen(service.refreshAccess(value.deviceAccess)),
      ),
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

  const linkedAgentUpstream: DeviceService["Service"]["linkedAgentUpstream"] = (
    hostId,
    token,
    path,
  ) => {
    const host = linkedHosts.get(hostId as DeviceHostId);
    return host ? host.agentUpstream(token, path) : Effect.succeedNone;
  };

  return {
    ...service,
    easAccount,
    simlockIdentity,
    linkedAgentUpstream,
  };
});

export const layer = Layer.effect(DeviceService, make).pipe(
  Layer.provide(LocalDeviceHost.layer),
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
