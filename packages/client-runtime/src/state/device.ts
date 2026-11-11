import {
  DEVICE_WIFI_PAIRING_FAILURE_LABELS,
  type DevicePlatform,
  type DeviceServiceState,
  type DeviceSummary,
  type DeviceToolVersions,
  type EnvironmentId,
  type LinkedDeviceState,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "./runtime.ts";

/**
 * Lists the environment's devices while mounted: the server discovers devices
 * only when a client asks. Probing never installs or starts helpers.
 */
export function createDeviceHostProbeAtom<A, E>(
  list: AtomCommand<{ environmentId: EnvironmentId; input: {} }, A, E>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Effect.promise(() =>
        runAtomCommand(get.registry, list, { environmentId, input: {} }, { reportFailure: false }),
      ).pipe(Effect.asVoid),
    ).pipe(Atom.withLabel(`device-host-probe:${environmentId}`)),
  );
}

export const NO_DEVICE_PROBE_ATOM = Atom.make(AsyncResult.initial<void, never>()).pipe(
  Atom.withLabel("device-host-probe:none"),
);

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  // An EAS Simulator start can take minutes; it must not hold up powering off
  // another device or turning device support off, so each device opens in its
  // own lane. Every EAS start opens the same catalog device, so the thread is
  // part of the lane too.
  const openConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: {
        readonly threadId: string;
        readonly hostId?: string | undefined;
        readonly deviceId: string;
      };
    }) =>
      JSON.stringify([environmentId, "open", input.threadId, input.hostId ?? null, input.deviceId]),
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:state",
      tag: WS_METHODS.subscribeDeviceState,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:configure",
      tag: WS_METHODS.deviceConfigure,
      scheduler,
      concurrency,
    }),
    testHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:test-host",
      tag: WS_METHODS.deviceTestHost,
    }),
    easAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:eas-account",
      tag: WS_METHODS.deviceEasAccount,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:list",
      tag: WS_METHODS.deviceList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:open",
      tag: WS_METHODS.deviceOpen,
      scheduler,
      concurrency: openConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:close",
      tag: WS_METHODS.deviceClose,
      scheduler,
      concurrency,
    }),
    shutdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:shutdown",
      tag: WS_METHODS.deviceShutdown,
      scheduler,
      concurrency,
    }),
    detail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:detail",
      tag: WS_METHODS.deviceDetail,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:action",
      tag: WS_METHODS.deviceAction,
      scheduler,
      concurrency,
    }),
    setHold: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:set-hold",
      tag: WS_METHODS.deviceSetHold,
    }),
    input: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:input",
      tag: WS_METHODS.deviceInput,
    }),
    setAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:set-access",
      tag: WS_METHODS.deviceSetAccess,
      scheduler,
      concurrency,
    }),
    wifiPairStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:wifi-pair-start",
      tag: WS_METHODS.deviceWifiPairStart,
    }),
    wifiPairCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:wifi-pair-cancel",
      tag: WS_METHODS.deviceWifiPairCancel,
    }),
    forget: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:forget",
      tag: WS_METHODS.deviceForget,
      scheduler,
      concurrency,
    }),
    answerLinkRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:answer-link-request",
      tag: WS_METHODS.deviceAnswerLinkRequest,
      scheduler,
      concurrency,
    }),
    setLinkBlocked: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:set-link-blocked",
      tag: WS_METHODS.deviceSetLinkBlocked,
      scheduler,
      concurrency,
    }),
  };
}

export type DeviceKindGroup = {
  readonly kind: DevicePlatform | "physical";
  readonly devices: ReadonlyArray<DeviceSummary>;
};

/** Where a group of devices is attached: this environment's machines, or a linked environment's. */
export type DeviceSourceGroup = {
  readonly key: string;
  readonly linked: {
    readonly label: string;
    readonly environmentId: string;
    readonly state: LinkedDeviceState;
    readonly detail: string | undefined;
  } | null;
  readonly groups: ReadonlyArray<DeviceKindGroup>;
};

export const LINKED_DEVICE_STATE_LABELS: Record<LinkedDeviceState, string> = {
  connected: "Connected",
  link_down: "Link down",
  linked_environments_off: "Links off there",
  devices_off: "Devices off there",
  not_allowed: "Not allowed",
  needs_update: "Needs update",
};

export const DEVICE_KIND_LABELS: Record<DeviceKindGroup["kind"], string> = {
  desktop: "This computer",
  physical: "Physical devices",
  ios: "iOS Simulators",
  android: "Android Emulators",
};

const byKind = (devices: ReadonlyArray<DeviceSummary>): ReadonlyArray<DeviceKindGroup> =>
  (["desktop", "physical", "ios", "android"] as const).flatMap((kind) => {
    const matching = devices
      .filter(
        (device) =>
          (device.platform === "desktop"
            ? "desktop"
            : device.physical
              ? "physical"
              : device.platform) === kind,
      )
      .sort((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    return matching.length > 0 ? [{ kind, devices: matching }] : [];
  });

/**
 * This environment's devices first, then each linked environment's under its label. A linked
 * environment shows even with no devices, so a link that is down still says so.
 */
export function groupDevicesBySource(state: DeviceServiceState): ReadonlyArray<DeviceSourceGroup> {
  const linkedHosts = state.hosts.flatMap((host) => (host.kind === "linked" ? [host] : []));
  const linkedIds = new Set(linkedHosts.map((host) => host.id));
  const own = byKind(state.devices.filter((device) => !linkedIds.has(device.hostId)));
  return [
    ...(own.length > 0 ? [{ key: "own", linked: null, groups: own }] : []),
    ...[...linkedHosts]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((host) => ({
        key: host.id,
        linked: {
          label: host.label,
          environmentId: host.environmentId,
          state: host.linkState,
          detail: host.linkDetail,
        },
        groups: byKind(state.devices.filter((device) => device.hostId === host.id)),
      })),
  ];
}

/** Whether `device` is attached to a linked environment's machine rather than this one's. */
export const isLinkedDevice = (state: DeviceServiceState, device: Pick<DeviceSummary, "hostId">) =>
  state.hosts.some((host) => host.id === device.hostId && host.kind === "linked");

/** Who from a linked environment is using `device` here, for its owner to see; null if nobody. */
export function deviceLinkedUse(
  state: DeviceServiceState,
  device: Pick<DeviceSummary, "hostId" | "id">,
): string | null {
  const session = state.sessions.find(
    (candidate) =>
      candidate.linked !== undefined &&
      candidate.hostId === device.hostId &&
      candidate.deviceId === device.id,
  );
  if (!session?.linked) return null;
  return session.linked.threadTitle
    ? `Used by “${session.linked.threadTitle}” on ${session.linked.label}`
    : `Used from ${session.linked.label}`;
}

export function deviceToolVersionLabels(tools: DeviceToolVersions | undefined) {
  if (!tools) return ["Device tool versions have not been checked."];
  return (
    [
      ["Device hub", tools.hub],
      ["Agent tools", tools.agent],
    ] as const
  ).map(([name, tool]) => {
    const installed = tool.installedVersions.length ? tool.installedVersions.join(", ") : "none";
    return `${name}: installed ${installed}; required ${tool.requiredVersion}${tool.runningVersion ? `; running ${tool.runningVersion}` : ""}.`;
  });
}

export function deviceToolUpdatePolicy(tools: DeviceToolVersions | undefined) {
  if (!tools) return "Versions have not been checked. Reconnect the host and check versions.";
  const outdated = [tools.hub, tools.agent].filter(
    (tool) =>
      tool.installedVersions.length > 0 && !tool.installedVersions.includes(tool.requiredVersion),
  );
  return outdated.length > 0
    ? "Update pending. Required tools will install automatically when next used. The host needs network access; an older install is not used as a fallback."
    : "Required tools are installed automatically when needed. Checking versions does not install or start anything.";
}
export const deviceToolUpdateOwnership =
  "This environment's T3 server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.";

/** What a Wi-Fi pairing screen shows, from the attempt this client started and the live state. */
export type WifiPairingView =
  | { readonly kind: "starting" }
  | { readonly kind: "elsewhere"; readonly attemptId: string }
  | {
      readonly kind: "waiting" | "pairing" | "connecting";
      readonly qrPayload: string;
      readonly label: string;
    }
  | { readonly kind: "connected"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string; readonly detail?: string };

const WIFI_PAIRING_STEP_LABELS = {
  waiting: "Waiting for your phone to scan the code…",
  pairing: "Pairing with your phone…",
  connecting: "Connecting to your phone…",
} as const;

export function wifiPairingView(input: {
  readonly state: DeviceServiceState;
  /** The attempt this client started, with the state revision the start answered with. */
  readonly attempt: {
    readonly attemptId: string;
    readonly qrPayload: string;
    readonly revision: number;
  } | null;
  /** Why starting failed: another client's attempt, or a message to show. */
  readonly startError: "busy" | string | null;
}): WifiPairingView {
  const live = input.state.wifiPairing;
  if (input.startError === "busy")
    return live && live.status !== "connected" && live.status !== "failed"
      ? { kind: "elsewhere", attemptId: live.attemptId }
      : { kind: "failed", label: "The other pairing attempt ended. Try again." };
  if (input.startError !== null && input.startError !== "busy")
    return { kind: "failed", label: input.startError };
  if (!input.attempt) return { kind: "starting" };
  const mine = live?.attemptId === input.attempt.attemptId ? live : undefined;
  // A state as new as the start answer that lacks the attempt means someone cancelled it;
  // an older one has not caught up yet.
  if (!mine && input.state.revision >= input.attempt.revision)
    return { kind: "failed", label: "Pairing was cancelled on another device." };
  if (mine?.status === "connected") {
    const device = input.state.devices.find((candidate) => candidate.id === mine.deviceId);
    return { kind: "connected", label: `Connected to ${device?.name ?? "your phone"}.` };
  }
  if (mine?.status === "failed")
    return {
      kind: "failed",
      label: mine.reason ? DEVICE_WIFI_PAIRING_FAILURE_LABELS[mine.reason] : "Pairing failed.",
      ...(mine.detail ? { detail: mine.detail } : {}),
    };
  const kind = mine?.status ?? "waiting";
  return { kind, qrPayload: input.attempt.qrPayload, label: WIFI_PAIRING_STEP_LABELS[kind] };
}

/** The steps on the phone, in the words Android uses. */
export const WIFI_PAIRING_PHONE_STEPS = [
  "On the phone, open Settings > Developer options.",
  "Turn on Wireless debugging, then open it.",
  "Tap Pair device with QR code and scan this code.",
] as const;

export type LinkedDeviceSource = {
  readonly environmentId: string;
  readonly label: string;
  readonly hidden: boolean;
  /** What the linked environment answered last, or null before it was asked. */
  readonly status: string | null;
};

/** Every linked environment as a device source this environment can hide or show again. */
export function linkedDeviceSources(input: {
  readonly links: ReadonlyMap<string, string>;
  readonly hidden: ReadonlyArray<string>;
  readonly state: DeviceServiceState;
}): ReadonlyArray<LinkedDeviceSource> {
  return [...input.links]
    .map(([environmentId, label]) => {
      const host = input.state.hosts.find(
        (candidate) => candidate.kind === "linked" && candidate.environmentId === environmentId,
      );
      const count = input.state.devices.filter((device) => device.hostId === host?.id).length;
      const hidden = input.hidden.includes(environmentId);
      return {
        environmentId,
        label,
        hidden,
        status:
          hidden || host?.kind !== "linked"
            ? null
            : host.linkState === "connected"
              ? `${count} ${count === 1 ? "device" : "devices"}`
              : LINKED_DEVICE_STATE_LABELS[host.linkState],
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}
