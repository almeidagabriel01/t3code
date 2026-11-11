import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DeviceHostId = typeof DeviceHostId.Type;

export const LOCAL_DEVICE_HOST_ID = "local" as DeviceHostId;
export const LOCAL_DEVICE_HOST_LABEL = "This machine";

const ConfiguredDeviceHostId = DeviceHostId.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  Schema.makeFilter((id) => id !== "local" || "The local host id is reserved."),
);

export const SshDeviceHostConfig = Schema.Struct({
  // Hosts saved before EAS hosts existed carry no kind.
  kind: Schema.Literal("ssh").pipe(Schema.withDecodingDefaultKey(Effect.succeed("ssh" as const))),
  id: ConfiguredDeviceHostId,
  label: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString.check(Schema.isPattern(/^[^\s-][^\s]*$/)),
  identityFile: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
});
export type SshDeviceHostConfig = typeof SshDeviceHostConfig.Type;

/**
 * Cloud simulators from EAS Simulator. Sessions bill the Expo account until
 * they stop, so every one is bounded. The Expo credential is not stored here.
 */
export const EasDeviceHostConfig = Schema.Struct({
  kind: Schema.Literal("eas"),
  id: ConfiguredDeviceHostId,
  label: TrimmedNonEmptyString,
  /** EAS project that sessions run under, when the project's app config does not name one. */
  appId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Expo access token, kept in the secret store, or the secret provider to read
   * it from. When empty the server uses EXPO_TOKEN, then the `eas login` session.
   * This is `secretSetting` from settings.ts, which imports this module.
   */
  accessToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  /** EAS allows at most 40 minutes on free accounts and 115 on paid ones. */
  maxSessionMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 115 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(30)),
  ),
  idleMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(10)),
  ),
  maxConcurrentSessions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
}).check(
  // EAS requires the idle limit to be smaller than the session limit.
  Schema.makeFilter(
    (host: { readonly idleMinutes: number; readonly maxSessionMinutes: number }) =>
      host.idleMinutes < host.maxSessionMinutes ||
      "Idle minutes must be smaller than session minutes.",
  ),
);
export type EasDeviceHostConfig = typeof EasDeviceHostConfig.Type;

/**
 * Alpha: devices leased from a Simlock gateway (https://incubator.callstack.com/simlock).
 * T3 never installs Simlock; the gateway and its workers are the user's own.
 */
export const SimlockDeviceHostConfig = Schema.Struct({
  kind: Schema.Literal("simlock"),
  id: ConfiguredDeviceHostId,
  label: TrimmedNonEmptyString,
  /** The gateway's origin, such as https://gateway.example.ts.net:4700. */
  gatewayUrl: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/[^\s/]+\/?$/)),
  /**
   * Leases, drives, watches, and takes input on its own leases. Kept in the secret store, or the
   * secret provider to read it from.
   */
  agentToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
  maxLeases: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
  /** A lease the Device panel keeps alive ends this long after it started. */
  maxLeaseMinutes: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 240 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(60)),
  ),
});
export type SimlockDeviceHostConfig = typeof SimlockDeviceHostConfig.Type;

export type DeviceHostConfig = SshDeviceHostConfig | EasDeviceHostConfig | SimlockDeviceHostConfig;

const uniqueHostIds = Schema.makeFilter(
  (hosts: ReadonlyArray<{ readonly id: string }>) =>
    new Set(hosts.map((host) => host.id)).size === hosts.length ||
    "Device host ids must be unique.",
);

export const SshDeviceHostConfigs = Schema.Array(SshDeviceHostConfig).check(uniqueHostIds);

/**
 * Kept apart from the SSH hosts in settings: servers and clients from before
 * EAS hosts decode `deviceHosts` as SSH hosts and would reject the whole file
 * or snapshot over one EAS entry.
 */
export const EasDeviceHostConfigs = Schema.Array(EasDeviceHostConfig).check(uniqueHostIds);

/** Kept apart from the other host lists for the same reason as EAS hosts. */
export const SimlockDeviceHostConfigs = Schema.Array(SimlockDeviceHostConfig).check(uniqueHostIds);

export const DeviceEasAccountInput = Schema.Struct({
  /** A saved EAS host whose stored token is checked when no new token is given. */
  hostId: Schema.optional(DeviceHostId),
  accessToken: Schema.optional(SettingsSecretValue),
});
export type DeviceEasAccountInput = typeof DeviceEasAccountInput.Type;

export const DeviceEasAccount = Schema.Struct({
  signedInAs: Schema.String,
  credentialSource: Schema.Literals(["settings", "env", "eas-login"]),
  apps: Schema.Array(Schema.Struct({ id: Schema.String, fullName: Schema.String })),
});
export type DeviceEasAccount = typeof DeviceEasAccount.Type;

export const DeviceSimlockIdentityInput = Schema.Struct({
  /** Without one, the gateway this machine's agent-device points at. */
  gatewayUrl: Schema.optional(TrimmedString),
  /** A saved Simlock host whose stored token is checked when no new token is given. */
  hostId: Schema.optional(DeviceHostId),
  agentToken: Schema.optional(SettingsSecretValue),
});
export type DeviceSimlockIdentityInput = typeof DeviceSimlockIdentityInput.Type;

export const DeviceSimlockIdentity = Schema.Struct({
  gatewayUrl: Schema.String,
  /** The label the gateway gave the token. */
  signedInAs: Schema.String,
  /** `env`: this machine's AGENT_DEVICE_DAEMON_AUTH_TOKEN, used because it targets this gateway. */
  tokenSource: Schema.Literals(["entered", "settings", "env"]),
});
export type DeviceSimlockIdentity = typeof DeviceSimlockIdentity.Type;

export class DeviceSimlockIdentityError extends Schema.TaggedError<DeviceSimlockIdentityError>()(
  "DeviceSimlockIdentityError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Checking an Expo credential failed; no device host is involved yet. */
export class DeviceEasAccountError extends Schema.TaggedError<DeviceEasAccountError>()(
  "DeviceEasAccountError",
  // No cause: this error reaches the browser, and the reason already says what Expo answered.
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const DeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceId = typeof DeviceId.Type;

export const DeviceSummary = Schema.Struct({
  hostId: DeviceHostId,
  id: DeviceId,
  platform: DevicePlatform,
  name: TrimmedNonEmptyString,
  version: Schema.String,
  booted: Schema.Boolean,
  physical: Schema.Boolean,
  /** How a physical Android phone reaches adb. Absent for everything else. */
  connection: Schema.optional(Schema.Literals(["usb", "wifi"])),
  /**
   * What names this device when its id does not last: an emulator's AVD name (its id becomes a
   * serial once booted) and a Wi-Fi phone's hardware serial (its id is an address).
   */
  identity: Schema.optional(Schema.String),
});
export type DeviceSummary = typeof DeviceSummary.Type;

export const DEVICE_CONNECTION_LABELS: Record<NonNullable<DeviceSummary["connection"]>, string> = {
  usb: "USB",
  wifi: "Wi-Fi",
};

type DeviceIdentityFields = Pick<DeviceSummary, "id"> & Partial<Pick<DeviceSummary, "identity">>;

/** The name a device keeps across boots and reconnects: its host's `identity`, or else its id. */
export const deviceIdentity = (device: DeviceIdentityFields): string =>
  device.identity ?? device.id;

/** What agents may do with one device. The user's own Device panel is never gated. */
export const DeviceAccessPolicy = Schema.Literals(["allow", "ask", "deny"]);
export type DeviceAccessPolicy = typeof DeviceAccessPolicy.Type;

/**
 * Stored policies by `deviceAccessKey`. Values stay loose: one value a newer
 * build wrote must not fail the settings decode, and it is kept on write.
 */
export const DeviceAccessMap = Schema.Record(Schema.String, Schema.Unknown);
export type DeviceAccessMap = typeof DeviceAccessMap.Type;

/** Host ids hold no colon, so the first one splits the key. */
export const deviceAccessKey = (
  device: DeviceIdentityFields & { readonly hostId: string },
): string => `${device.hostId}:${deviceIdentity(device)}`;

/** The key builds before stable identities wrote; a policy stored under it still applies. */
export const legacyDeviceAccessKey = (device: {
  readonly hostId: string;
  readonly id: string;
}): string => `${device.hostId}:${device.id}`;

export const defaultDeviceAccessPolicy = (device: {
  readonly physical: boolean;
}): DeviceAccessPolicy => (device.physical ? "ask" : "allow");

const isDeviceAccessPolicy = Schema.is(DeviceAccessPolicy);

/** The stored policy for a device, or undefined when none (or an unreadable one) is stored. */
export function storedDeviceAccessPolicy(
  access: DeviceAccessMap | undefined,
  device: DeviceIdentityFields & { readonly hostId: string },
): DeviceAccessPolicy | undefined {
  if (access === undefined) return undefined;
  for (const key of [deviceAccessKey(device), legacyDeviceAccessKey(device)]) {
    const stored = Object.hasOwn(access, key) ? access[key] : undefined;
    if (isDeviceAccessPolicy(stored)) return stored;
  }
  return undefined;
}

export const deviceAccessPolicy = (
  access: DeviceAccessMap | undefined,
  device: DeviceIdentityFields & { readonly hostId: string; readonly physical: boolean },
): DeviceAccessPolicy =>
  storedDeviceAccessPolicy(access, device) ?? defaultDeviceAccessPolicy(device);

export const DEVICE_ACCESS_POLICY_LABELS: Record<
  DeviceAccessPolicy,
  { readonly label: string; readonly description: string }
> = {
  allow: { label: "Allow", description: "Agents can open and drive this device." },
  ask: {
    label: "Ask first",
    description:
      "Each thread asks you once before using it; the tasks it delegates share the answer.",
  },
  deny: { label: "Never", description: "Agents cannot use this device." },
};

/** The user is driving this device by hand; agents wait until it is handed back. */
export const DeviceHold = Schema.Struct({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  since: Schema.String,
});
export type DeviceHold = typeof DeviceHold.Type;

export const findDeviceHold = (
  holds: ReadonlyArray<DeviceHold> | undefined,
  device: { readonly hostId: string; readonly id: string },
): DeviceHold | undefined =>
  holds?.find((hold) => hold.hostId === device.hostId && hold.deviceId === device.id);

export const DevicePlatformAvailability = Schema.Struct({
  platform: DevicePlatform,
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export type DevicePlatformAvailability = typeof DevicePlatformAvailability.Type;

export const DeviceToolVersion = Schema.Struct({
  requiredVersion: Schema.String,
  installedVersions: Schema.Array(Schema.String),
  runningVersion: Schema.NullOr(Schema.String),
});
export type DeviceToolVersion = typeof DeviceToolVersion.Type;

export const DeviceToolVersions = Schema.Struct({
  hub: DeviceToolVersion,
  agent: DeviceToolVersion,
});
export type DeviceToolVersions = typeof DeviceToolVersions.Type;

const deviceHostSummaryFields = {
  id: DeviceHostId,
  label: TrimmedNonEmptyString,
  platforms: Schema.Array(DevicePlatformAvailability),
  tools: Schema.optional(DeviceToolVersions),
  toolInspectionError: Schema.optional(Schema.String),
  hubInstalled: Schema.Boolean,
  agentDeviceInstalled: Schema.Boolean,
};
const MachineDeviceHostSummary = Schema.Struct({
  ...deviceHostSummaryFields,
  kind: Schema.Literals(["local", "ssh"]),
});
const EasDeviceHostSummary = Schema.Struct({
  ...deviceHostSummaryFields,
  kind: Schema.Literal("eas"),
});
const SimlockDeviceHostSummary = Schema.Struct({
  ...deviceHostSummaryFields,
  kind: Schema.Literal("simlock"),
});
export const DeviceHostSummary = Schema.Union([
  MachineDeviceHostSummary,
  EasDeviceHostSummary,
  SimlockDeviceHostSummary,
]);
export type DeviceHostSummary = typeof DeviceHostSummary.Type;

export const DeviceHostStatus = Schema.Literals([
  "disabled",
  "idle",
  "installing",
  "starting",
  "ready",
  "failed",
]);
export type DeviceHostStatus = typeof DeviceHostStatus.Type;

export const DeviceSession = Schema.Struct({
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  openedAt: Schema.String,
});
export type DeviceSession = typeof DeviceSession.Type;

export const DeviceHostStatuses = Schema.Record(
  DeviceHostId,
  Schema.Struct({
    status: DeviceHostStatus,
    detail: Schema.optional(Schema.String),
    androidDiscoveryIncomplete: Schema.optional(Schema.Boolean),
    incompletePlatforms: Schema.optional(Schema.Array(DevicePlatform)),
  }),
);

/** Why pairing a phone over Wi-Fi stopped. */
export const DeviceWifiPairingFailure = Schema.Literals([
  "adb_missing",
  "mdns_unavailable",
  "timeout",
  "wrong_network",
  "pair_refused",
]);
export type DeviceWifiPairingFailure = typeof DeviceWifiPairingFailure.Type;

export const DEVICE_WIFI_PAIRING_FAILURE_LABELS: Record<DeviceWifiPairingFailure, string> = {
  adb_missing: "adb is not installed on this device host. Install Android platform tools.",
  mdns_unavailable: "adb cannot discover phones on the network (mDNS is unavailable).",
  timeout: "No phone scanned the code in time.",
  wrong_network: "The phone could not be reached. Put it on the same Wi-Fi network as the host.",
  pair_refused: "The phone refused to pair. Scan a fresh code.",
};

/** A Wi-Fi pairing attempt as every client sees it. The password is never part of it. */
export const DeviceWifiPairing = Schema.Struct({
  attemptId: Schema.String,
  hostId: DeviceHostId,
  status: Schema.Literals(["waiting", "pairing", "connecting", "connected", "failed"]),
  reason: Schema.optional(DeviceWifiPairingFailure),
  /** adb's own words for a failure, for the user to act on. */
  detail: Schema.optional(Schema.String),
  /** The paired phone's id once connected. */
  deviceId: Schema.optional(DeviceId),
});
export type DeviceWifiPairing = typeof DeviceWifiPairing.Type;

const deviceServiceStateFields = {
  supportsHostRetry: Schema.optional(Schema.Boolean),
  supportsToolUpdate: Schema.optional(Schema.Boolean),
  supportsToolInspection: Schema.optional(Schema.Boolean),
  /** Servers from before EAS hosts ignore `easDeviceHosts`, so clients offer them only when set. */
  supportsEasHosts: Schema.optional(Schema.Boolean),
  /** Servers from before Simlock hosts ignore `simlockDeviceHosts`. */
  supportsSimlockHosts: Schema.optional(Schema.Boolean),
  /** Servers from before takeover and device access have neither RPC. */
  supportsDeviceControl: Schema.optional(Schema.Boolean),
  holds: Schema.optional(Schema.Array(DeviceHold)),
  /** Servers from before Wi-Fi pairing have neither its RPCs nor `wifiPairing`. */
  supportsWifiPairing: Schema.optional(Schema.Boolean),
  wifiPairing: Schema.optional(DeviceWifiPairing),
  /** The stored `deviceAccess` setting; devices without an entry use their default. */
  access: Schema.optional(DeviceAccessMap),
  hostStatus: DeviceHostStatus,
  hostStatusDetail: Schema.optional(Schema.String),
  hostStatuses: DeviceHostStatuses,
  devices: Schema.Array(DeviceSummary),
  sessions: Schema.Array(DeviceSession),
  bootingDevices: Schema.optional(
    Schema.Array(Schema.Struct({ ...DeviceSummary.fields, threadId: ThreadId })),
  ),
  onboardingCompleted: Schema.Boolean,
  agentAccessEnabled: Schema.Boolean,
  hubBasePath: Schema.String,
  revision: Schema.Int,
};

/**
 * EAS host summaries travel as `easHosts`: clients from before EAS hosts
 * decode `hosts` with a `local | ssh` kind and would reject the whole state.
 * Decoded, every host is in `hosts`.
 */
const DeviceServiceStateWire = Schema.Struct({
  ...deviceServiceStateFields,
  hosts: Schema.Array(MachineDeviceHostSummary),
  easHosts: Schema.optional(Schema.Array(EasDeviceHostSummary)),
  simlockHosts: Schema.optional(Schema.Array(SimlockDeviceHostSummary)),
});
const DeviceServiceStateDecoded = Schema.Struct({
  ...deviceServiceStateFields,
  hosts: Schema.Array(DeviceHostSummary),
});

export const DeviceServiceState = DeviceServiceStateWire.pipe(
  Schema.decodeTo(
    Schema.toType(DeviceServiceStateDecoded),
    SchemaTransformation.transform<
      typeof DeviceServiceStateDecoded.Type,
      typeof DeviceServiceStateWire.Type
    >({
      decode: ({ easHosts, simlockHosts, ...state }) => ({
        ...state,
        hosts: [...state.hosts, ...(easHosts ?? []), ...(simlockHosts ?? [])],
      }),
      encode: (state) => ({
        ...state,
        hosts: state.hosts.filter(
          (host): host is typeof MachineDeviceHostSummary.Type =>
            host.kind === "local" || host.kind === "ssh",
        ),
        easHosts: state.hosts.filter(
          (host): host is typeof EasDeviceHostSummary.Type => host.kind === "eas",
        ),
        simlockHosts: state.hosts.filter(
          (host): host is typeof SimlockDeviceHostSummary.Type => host.kind === "simlock",
        ),
      }),
    }),
  ),
);
export type DeviceServiceState = typeof DeviceServiceState.Type;

export const DeviceListInput = Schema.Struct({
  updateTool: Schema.optional(Schema.Literals(["hub", "agent"])),
  inspectOnly: Schema.optional(Schema.Boolean),
  retryHostId: Schema.optional(DeviceHostId),
});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceConfigureInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  agentAccessEnabled: Schema.optional(Schema.Boolean),
  onboardingCompleted: Schema.optional(Schema.Boolean),
});
export type DeviceConfigureInput = typeof DeviceConfigureInput.Type;

export const DeviceOpenInput = Schema.Struct({
  threadId: ThreadId,
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
  /** Boot the simulator or emulator when it is not running. Defaults to true. */
  boot: Schema.optional(Schema.Boolean),
});
export type DeviceOpenInput = typeof DeviceOpenInput.Type;

export const DeviceCloseInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  threadId: ThreadId,
  /** Omit to close every device session for the thread. */
  deviceId: Schema.optional(DeviceId),
  /** Also shut the simulator or emulator down. Defaults to false. */
  shutdown: Schema.optional(Schema.Boolean),
});
export type DeviceCloseInput = typeof DeviceCloseInput.Type;

export const DeviceShutdownInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
});
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

export const DeviceSetHoldInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  /** True takes the device over; false hands it back. Both are idempotent. */
  held: Schema.Boolean,
});
export type DeviceSetHoldInput = typeof DeviceSetHoldInput.Type;

export const DeviceSetAccessInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  /** Null removes the stored policy, which returns the device to its default. */
  policy: Schema.NullOr(DeviceAccessPolicy),
});
export type DeviceSetAccessInput = typeof DeviceSetAccessInput.Type;

export const DeviceWifiPairStartInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  /** A repeat with the same id returns the same attempt. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type DeviceWifiPairStartInput = typeof DeviceWifiPairStartInput.Type;

export const DeviceWifiPairStartResult = Schema.Struct({
  attemptId: Schema.String,
  /** What the phone scans: `WIFI:T:ADB;S:<service name>;P:<password>;;`. */
  qrPayload: Schema.String,
  state: DeviceServiceState,
});
export type DeviceWifiPairStartResult = typeof DeviceWifiPairStartResult.Type;

/** Stops a running attempt, or clears a finished one. Unknown ids change nothing. */
export const DeviceWifiPairCancelInput = Schema.Struct({ attemptId: Schema.String });
export type DeviceWifiPairCancelInput = typeof DeviceWifiPairCancelInput.Type;

export const DeviceForgetInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
});
export type DeviceForgetInput = typeof DeviceForgetInput.Type;

export const DeviceAppearance = Schema.Literals(["light", "dark"]);
export type DeviceAppearance = typeof DeviceAppearance.Type;

export const DeviceTextSize = Schema.Literals(["small", "default", "large", "extra-large"]);
export type DeviceTextSize = typeof DeviceTextSize.Type;

export const DeviceColorFilter = Schema.Literals([
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
]);
export type DeviceColorFilter = typeof DeviceColorFilter.Type;

export const DeviceOrientation = Schema.Literals([
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
]);
export type DeviceOrientation = typeof DeviceOrientation.Type;

export const DeviceSettings = Schema.Struct({
  appearance: Schema.optional(DeviceAppearance),
  textSize: Schema.optional(DeviceTextSize),
  reduceMotion: Schema.optional(Schema.Boolean),
  increaseContrast: Schema.optional(Schema.Boolean),
  reduceTransparency: Schema.optional(Schema.Boolean),
  showBorders: Schema.optional(Schema.Boolean),
  voiceOver: Schema.optional(Schema.Boolean),
  liquidGlass: Schema.optional(Schema.Literals(["clear", "tinted"])),
  colorFilter: Schema.optional(DeviceColorFilter),
  networkEnabled: Schema.optional(Schema.Boolean),
  location: Schema.optional(
    Schema.NullOr(Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number })),
  ),
});
export type DeviceSettings = typeof DeviceSettings.Type;

export const DeviceForegroundApp = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
});
export type DeviceForegroundApp = typeof DeviceForegroundApp.Type;

export const DeviceDetail = Schema.Struct({
  hostId: DeviceHostId,
  deviceId: DeviceId,
  settings: DeviceSettings,
  foregroundApp: Schema.NullOr(DeviceForegroundApp),
  readAt: Schema.String,
});
export type DeviceDetail = typeof DeviceDetail.Type;

export const DevicePermission = Schema.Literals([
  "camera",
  "microphone",
  "photos",
  "contacts",
  "calendar",
  "reminders",
  "location",
  "notifications",
  "motion",
  "media-library",
  "faceid",
]);
export type DevicePermission = typeof DevicePermission.Type;

const DeviceTarget = {
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
};

export const DeviceActionInput = Schema.Union([
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setAppearance"),
    value: DeviceAppearance,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("setTextSize"), value: DeviceTextSize }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setToggle"),
    setting: Schema.Literals([
      "reduceMotion",
      "increaseContrast",
      "reduceTransparency",
      "showBorders",
      "voiceOver",
      "networkEnabled",
    ]),
    value: Schema.Boolean,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLiquidGlass"),
    value: Schema.Literals(["clear", "tinted"]),
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setColorFilter"),
    value: DeviceColorFilter,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setOrientation"),
    value: DeviceOrientation,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setLocation"),
    latitude: Schema.Number.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Number.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("clearLocation") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("setPermission"),
    appId: TrimmedNonEmptyString,
    permission: DevicePermission,
    decision: Schema.Literals(["grant", "revoke", "reset"]),
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("openUrl"), url: TrimmedNonEmptyString }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("launchApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("terminateApp"),
    appId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...DeviceTarget, type: Schema.Literal("shake") }),
  Schema.Struct({
    ...DeviceTarget,
    type: Schema.Literal("sendPush"),
    appId: TrimmedNonEmptyString,
    payload: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
  }),
]);
export type DeviceActionInput = typeof DeviceActionInput.Type;
export type DeviceActionType = DeviceActionInput["type"];

export const DeviceDetailInput = Schema.Struct(DeviceTarget);
export type DeviceDetailInput = typeof DeviceDetailInput.Type;

export class DeviceHostUnavailableError extends Schema.TaggedError<DeviceHostUnavailableError>()(
  "DeviceHostUnavailableError",
  {
    hostId: DeviceHostId,
    /** The host's name in Settings, which the message shows instead of its id. */
    hostLabel: Schema.optional(Schema.String),
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.hostLabel ?? `Device host ${this.hostId}`} is unavailable: ${this.reason}`;
  }
}

export class DevicePlatformUnavailableError extends Schema.TaggedError<DevicePlatformUnavailableError>()(
  "DevicePlatformUnavailableError",
  {
    hostId: DeviceHostId,
    platform: DevicePlatform,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.platform} devices are unavailable on host ${this.hostId}: ${this.reason}`;
  }
}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  {
    hostId: DeviceHostId,
    deviceId: DeviceId,
  },
) {
  override get message(): string {
    return `Device ${this.deviceId} was not found on host ${this.hostId}.`;
  }
}

export class DeviceBootError extends Schema.TaggedError<DeviceBootError>()("DeviceBootError", {
  hostId: DeviceHostId,
  deviceId: DeviceId,
  reason: Schema.Literals(["disk_space", "timeout", "launch_failed"]),
  diagnostics: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const explanation = {
      disk_space: "There is not enough free disk space on its device host.",
      timeout: "The device did not become ready in time.",
      launch_failed: "The simulator or emulator could not start.",
    }[this.reason];
    const summary = `Device ${this.deviceId} failed to boot: ${explanation}`;
    return this.diagnostics
      ? `${summary}\n\n${this.diagnostics}`
      : `${summary} The device host sent no details. Try again or open another device; if it keeps failing, check the device on that host.`;
  }
}

export class DeviceOperationError extends Schema.TaggedError<DeviceOperationError>()(
  "DeviceOperationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "command_failed",
      "request_failed",
      "invalid_payload",
      "settings_failed",
      "hub_rejected",
    ]),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const explanation = {
      command_failed: `The device command failed${this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`}.`,
      request_failed: "Could not communicate with device support. Try refreshing devices.",
      invalid_payload: "The device request could not be encoded.",
      settings_failed: "Could not read or save device settings.",
      hub_rejected: "The device hub could not complete the request.",
    }[this.reason];
    return `Device ${this.operation} failed: ${explanation}`;
  }
}

export class DeviceActionUnavailableError extends Schema.TaggedError<DeviceActionUnavailableError>()(
  "DeviceActionUnavailableError",
  {
    operation: Schema.String,
    platform: DevicePlatform,
    reason: Schema.Literals(["unsupported", "helper_missing", "physical_device", "not_wifi"]),
  },
) {
  override get message(): string {
    if (this.reason === "not_wifi")
      return `Device ${this.operation} applies only to a phone connected over Wi-Fi.`;
    return this.reason === "helper_missing"
      ? `Device ${this.operation} requires a helper missing from this install. Set up device support again.`
      : this.reason === "physical_device"
        ? `Device ${this.operation} is not available for a physical device. Turn it on or off by hand.`
        : `Device ${this.operation} is not supported on ${this.platform}.`;
  }
}

const deviceRefusalFields = {
  hostId: DeviceHostId,
  deviceId: DeviceId,
  deviceName: Schema.optional(Schema.String),
};
const refusedDevice = (error: {
  readonly deviceId: string;
  readonly deviceName?: string | undefined;
}) => error.deviceName ?? `Device ${error.deviceId}`;

const NO_WORKAROUND = "Do not drive it another way, such as adb, simctl, idb or ssh.";

/** The user took the device over; only an explicit hand back ends it. */
export class DeviceHeldError extends Schema.TaggedError<DeviceHeldError>()("DeviceHeldError", {
  ...deviceRefusalFields,
  since: Schema.String,
}) {
  override get message(): string {
    return `The user is holding this device: ${refusedDevice(this)} is under their control since ${this.since}. Wait for them to hand it back in the Device panel, and do not retry in a loop. ${NO_WORKAROUND} device_screenshot still works. Tell the user you are waiting.`;
  }
}

export class DeviceAccessDeniedError extends Schema.TaggedError<DeviceAccessDeniedError>()(
  "DeviceAccessDeniedError",
  {
    ...deviceRefusalFields,
    /** `policy`: the setting is Never. `declined`: the user answered no for this thread. */
    reason: Schema.Literals(["policy", "declined"]),
  },
) {
  override get message(): string {
    return this.reason === "policy"
      ? `Agents are not allowed to use ${refusedDevice(this)}: its device access setting is Never. ${NO_WORKAROUND} Use another device, or ask the user to change it in Settings > Devices > Device access.`
      : `The user did not allow this thread to use ${refusedDevice(this)}. ${NO_WORKAROUND} Use another device, or ask the user to allow it in Settings > Devices > Device access.`;
  }
}

/** The user has not answered the access question yet. */
export class DeviceAccessPendingError extends Schema.TaggedError<DeviceAccessPendingError>()(
  "DeviceAccessPendingError",
  deviceRefusalFields,
) {
  override get message(): string {
    return `Still waiting for the user to allow this thread to use ${refusedDevice(this)}. Call again with the same arguments to keep waiting. ${NO_WORKAROUND}`;
  }
}

/** Another thread's agent already drives this device. */
export class DeviceInUseError extends Schema.TaggedError<DeviceInUseError>()("DeviceInUseError", {
  ...deviceRefusalFields,
  threadId: ThreadId,
  threadTitle: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const thread =
      this.threadTitle === undefined
        ? `thread ${this.threadId}`
        : `the thread "${this.threadTitle}" (${this.threadId})`;
    return `${refusedDevice(this)} is in use by the agent in ${thread}. Use another device, or wait until that thread closes it. Do not close or reuse that thread's session.`;
  }
}

/** Another client already started pairing a phone on this environment. */
export class DeviceWifiPairingBusyError extends Schema.TaggedError<DeviceWifiPairingBusyError>()(
  "DeviceWifiPairingBusyError",
  { hostId: DeviceHostId, attemptId: Schema.String },
) {
  override get message(): string {
    return "A phone is already being paired over Wi-Fi here. Cancel that attempt or wait for it to finish.";
  }
}

export const DeviceError = Schema.Union([
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
  DeviceHeldError,
  DeviceAccessDeniedError,
  DeviceAccessPendingError,
  DeviceInUseError,
]);
export type DeviceError = typeof DeviceError.Type;

export const DeviceToolListResult = Schema.Struct({
  hostStatuses: DeviceHostStatuses,
  hosts: Schema.Array(DeviceHostSummary),
  devices: Schema.Array(DeviceSummary),
  open: Schema.Array(Schema.Struct({ hostId: DeviceHostId, deviceId: DeviceId })),
  /** Devices the user is driving by hand; wait for a hand back before acting on one. */
  heldByUser: Schema.optional(Schema.Array(DeviceHold)),
});
export type DeviceToolListResult = typeof DeviceToolListResult.Type;

export const DeviceToolOpenInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device id from `device_list`. Default: the booted or last used device.",
    }),
  ),
  platform: Schema.optional(
    DevicePlatform.annotate({
      description: "Needed with no `deviceId` when both platforms exist.",
    }),
  ),
  hostId: Schema.optional(
    DeviceHostId.annotate({ description: "Host from `device_list`. Default local." }),
  ),
});
export type DeviceToolOpenInput = typeof DeviceToolOpenInput.Type;

export const DeviceToolOpenResult = Schema.Struct({
  device: DeviceSummary,
  agentDevice: Schema.Struct({
    command: Schema.String,
    targetArgs: Schema.Array(Schema.String),
    session: Schema.String,
  }),
  quickStart: Schema.String,
});
export type DeviceToolOpenResult = typeof DeviceToolOpenResult.Type;

export const DeviceToolTargetInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device. Default: the last one opened here.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
});
export type DeviceToolTargetInput = typeof DeviceToolTargetInput.Type;

export const DeviceToolScreenshotResult = Schema.Struct({
  device: DeviceSummary,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type DeviceToolScreenshotResult = typeof DeviceToolScreenshotResult.Type;

export const DeviceToolCloseInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device to close. None: close all here.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
  shutdown: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also turn it off. Default false.",
    }),
  ),
});
export type DeviceToolCloseInput = typeof DeviceToolCloseInput.Type;

export class DeviceToolUnavailableError extends Schema.TaggedError<DeviceToolUnavailableError>()(
  "DeviceToolUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const DeviceToolError = Schema.Union([
  DeviceToolUnavailableError,
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
  DeviceActionUnavailableError,
  DeviceHeldError,
  DeviceAccessDeniedError,
  DeviceAccessPendingError,
  DeviceInUseError,
]);
export type DeviceToolError = typeof DeviceToolError.Type;

export function deviceToolInstallMessage(name: string, tool: DeviceToolVersion | undefined) {
  if (!tool) return `Installing ${name}…`;
  const previous =
    tool.runningVersion ??
    [...tool.installedVersions].sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  return previous && !tool.installedVersions.includes(tool.requiredVersion)
    ? `Updating ${name} from ${previous} to ${tool.requiredVersion}…`
    : `Installing ${name} ${tool.requiredVersion}…`;
}
