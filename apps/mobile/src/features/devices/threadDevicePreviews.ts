import {
  DEVICE_CONNECTION_LABELS,
  DEVICE_ISSUES,
  deviceOpenBlocker,
  findDeviceHold,
  isCaptureDevice,
  type DevicePlatform,
  type DeviceServiceState,
  type DeviceSummary,
  type ThreadId,
} from "@t3tools/contracts";

const FALLBACK_NAMES: Record<DevicePlatform, string> = {
  ios: "iOS Simulator",
  android: "Android Emulator",
  desktop: "This computer",
};

/** Capture sources have no input socket, so the notice says who drives them instead. */
export function deviceViewOnlyNotice(platform: DevicePlatform) {
  return platform === "desktop"
    ? "View only. Agents use computer tools on this computer."
    : "View only. Use the phone to control it.";
}

/** Each issue as the user reads it: what is wrong, what to do, and whether it stops viewing. */
export function deviceIssueRows(device: Pick<DeviceSummary, "issues"> | undefined) {
  return (device?.issues ?? []).map((issue) => ({
    reason: issue.reason,
    title: DEVICE_ISSUES[issue.reason].title,
    action: DEVICE_ISSUES[issue.reason].action,
    detail: issue.detail,
    blocksView: DEVICE_ISSUES[issue.reason].blocks.includes("view"),
  }));
}

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(state: DeviceServiceState | null, threadId: ThreadId) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      const blocking = deviceOpenBlocker(device?.issues);
      const capture = device !== undefined && isCaptureDevice(device);
      return {
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? FALLBACK_NAMES[session.platform],
        description: [
          device?.platform === "desktop" ? "This computer" : device?.physical ? "Physical" : null,
          device?.connection ? DEVICE_CONNECTION_LABELS[device.connection] : null,
          device?.version,
          host?.label,
        ]
          .filter(Boolean)
          .join(" · "),
        physical: device?.physical === true,
        capture,
        viewOnlyNotice: capture ? deviceViewOnlyNotice(session.platform) : null,
        issues: deviceIssueRows(device),
        /** The issue that keeps the live screen from opening, which the preview shows instead. */
        blocked: blocking
          ? {
              title: DEVICE_ISSUES[blocking.reason].title,
              action: DEVICE_ISSUES[blocking.reason].action,
            }
          : null,
        canHold: state?.supportsDeviceControl === true,
        held:
          findDeviceHold(state?.holds, { hostId: session.hostId, id: session.deviceId }) !==
          undefined,
        serveSimOnly: host?.kind === "simlock",
      };
    });
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

/** The menu's takeover switch, absent on a server without device control. */
export function deviceHoldMenuItem(preview: ThreadDevicePreview | null, canHold: boolean) {
  if (!preview?.canHold) return null;
  return {
    id: "hold",
    title: preview.held ? "Hand back to the agent" : "Take over",
    icon: preview.held ? "arrow.uturn.backward" : "pause",
    disabled: !canHold,
    nextHeld: !preview.held,
  } as const;
}

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
