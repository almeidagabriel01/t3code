import type { DeviceIssue } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { HostDevice } from "./DeviceHost.ts";
import type { MacVideoCaptureList } from "./MacVideoCapture.ts";

/** UDIDs differ in hyphens and case between devicectl, the USB registry and AVFoundation. */
const normalizeUdid = (udid: string) => udid.replaceAll("-", "").toLowerCase();

// Only the fields used; every one optional, so a newer Xcode's JSON still reads. Deprecated
// top-level groups are read as a fallback for Xcodes that do not have `properties` yet.
const Text = Schema.optional(Schema.String);
const DevicectlDevice = Schema.Struct({
  identifier: Text,
  properties: Schema.optional(
    Schema.Struct({
      connection: Schema.optional(
        Schema.Struct({ pairingState: Text, state: Text, transportType: Text }),
      ),
      hardware: Schema.optional(
        Schema.Struct({ udid: Text, platform: Text, reality: Text, marketingName: Text }),
      ),
      state: Schema.optional(Schema.Struct({ name: Text })),
    }),
  ),
  connectionProperties: Schema.optional(
    Schema.Struct({ pairingState: Text, tunnelState: Text, transportType: Text }),
  ),
  deviceProperties: Schema.optional(
    Schema.Struct({ name: Text, osVersionNumber: Text, developerModeStatus: Text }),
  ),
  hardwareProperties: Schema.optional(
    Schema.Struct({ udid: Text, platform: Text, reality: Text, marketingName: Text }),
  ),
});
const decodeDevice = Schema.decodeUnknownOption(DevicectlDevice);
const decodeDevices = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ devices: Schema.Array(Schema.Unknown) }),
    }),
  ),
);

export interface DevicectlPhone {
  readonly udid: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly usb: boolean;
  readonly paired: boolean;
  /** Undefined when devicectl did not say. */
  readonly developerMode: boolean | undefined;
}

/**
 * Physical iOS devices from `devicectl list devices --json-output`. One unreadable entry is
 * skipped, never the whole list; unreadable JSON is null.
 */
export const parseDevicectl = (json: string): ReadonlyArray<DevicectlPhone> | null => {
  const parsed = decodeDevices(json);
  if (Option.isNone(parsed)) return null;
  return parsed.value.result.devices.flatMap((raw) => {
    const device = decodeDevice(raw);
    if (Option.isNone(device)) return [];
    const { properties, connectionProperties, deviceProperties, hardwareProperties } = device.value;
    const hardware = { ...hardwareProperties, ...properties?.hardware };
    const udid = hardware.udid ?? device.value.identifier;
    // iPadOS reports its platform as iOS.
    if (hardware.reality !== "physical" || hardware.platform !== "iOS" || !udid) return [];
    const transport = properties?.connection?.transportType ?? connectionProperties?.transportType;
    const pairing = properties?.connection?.pairingState ?? connectionProperties?.pairingState;
    const mode = deviceProperties?.developerModeStatus;
    return [
      {
        udid,
        name:
          properties?.state?.name ?? deviceProperties?.name ?? hardware.marketingName ?? "iPhone",
        version: deviceProperties?.osVersionNumber,
        // A cable shows as `wired`; Wi-Fi as `localNetwork`.
        usb: transport === "wired" && properties?.connection?.state !== "disconnected",
        paired: pairing === "paired",
        developerMode: mode === "enabled" ? true : mode === "disabled" ? false : undefined,
      },
    ];
  });
};

/**
 * USB iPhones and iPads to list: those devicectl sees on a cable, and those the capture helper sees
 * (which needs no Xcode). Each carries the issues its sources can prove; a locked phone only shows
 * when capture starts.
 */
export const listIphones = (input: {
  /** Null when devicectl could not run: Xcode is missing. */
  readonly devicectl: ReadonlyArray<DevicectlPhone> | null;
  /** Null when the helper could not list; its own issue explains why. */
  readonly helper: MacVideoCaptureList | null;
  readonly helperIssue: DeviceIssue | undefined;
  readonly signingReady: boolean;
}): ReadonlyArray<HostDevice> => {
  const seen = new Map(
    (input.helper?.iphones ?? []).map((phone) => [normalizeUdid(phone.udid), phone]),
  );
  const phones = (input.devicectl ?? []).filter(
    (phone) => phone.usb || seen.has(normalizeUdid(phone.udid)),
  );
  const known = new Set(phones.map((phone) => normalizeUdid(phone.udid)));
  const helperOnly = [...seen.values()].filter((phone) => !known.has(normalizeUdid(phone.udid)));
  const cameraDenied = input.helper?.permissions.camera === "denied";

  const issuesFor = (phone: DevicectlPhone | undefined): ReadonlyArray<DeviceIssue> => [
    ...(phone && !phone.paired ? [{ reason: "not_paired" as const }] : []),
    ...(input.helperIssue ? [input.helperIssue] : []),
    ...(cameraDenied ? [{ reason: "camera_permission" as const }] : []),
    ...(input.devicectl === null ? [{ reason: "xcode_missing" as const }] : []),
    ...(phone?.developerMode === false ? [{ reason: "developer_mode_off" as const }] : []),
    ...(input.signingReady ? [] : [{ reason: "signing_missing" as const }]),
  ];
  const device = (
    udid: string,
    name: string,
    version: string | undefined,
    issues: ReadonlyArray<DeviceIssue>,
  ): HostDevice => ({
    id: udid,
    platform: "ios",
    name,
    version: version ? `iOS ${version}` : "iOS",
    booted: true,
    physical: true,
    connection: "usb",
    ...(issues.length > 0 ? { issues } : {}),
  });
  return [
    ...phones.map((phone) => device(phone.udid, phone.name, phone.version, issuesFor(phone))),
    ...helperOnly.map((phone) => device(phone.udid, phone.name, undefined, issuesFor(undefined))),
  ];
};
