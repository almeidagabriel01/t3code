import { findDeviceHold, type DeviceServiceState, type ThreadId } from "@t3tools/contracts";

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(state: DeviceServiceState | null, threadId: ThreadId) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      return {
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
        description: [device?.physical ? "Physical" : null, device?.version, host?.label]
          .filter(Boolean)
          .join(" · "),
        physical: device?.physical === true,
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
