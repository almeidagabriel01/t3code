import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DeviceId,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
  LinkedDeviceState,
} from "./device.ts";

/**
 * Where an environment serves its devices to environments linked to it. Only a peer link's own
 * session reaches these routes; `/mcp` and these are the only paths that accept one.
 */
export const LINKED_DEVICE_ROUTE_PREFIX = "/api/linked-device";

/** The header a forwarded agent-device call names its thread in, as the linking side knows it. */
export const LINKED_DEVICE_THREAD_HEADER = "t3-linked-thread";

/** Why a device owner refused a link's call, so the linking side can show and say why. */
export const LinkedDeviceRefusal = Schema.Struct({
  state: LinkedDeviceState,
  message: Schema.String,
});
export type LinkedDeviceRefusal = typeof LinkedDeviceRefusal.Type;

/**
 * A thread on the linking side, as it names itself. The owner prefixes every id with the link's
 * session, so a link can claim lineage only with its own threads.
 */
export const LinkedDeviceThread = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  /** Threads that delegated to this one, nearest first. */
  ancestors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type LinkedDeviceThread = typeof LinkedDeviceThread.Type;

/** A hold on a device as the asking link sees it: its own, the owner's, or another link's. */
export const LinkedDeviceHold = Schema.Struct({
  deviceId: DeviceId,
  since: Schema.String,
  owner: Schema.Literals(["you", "owner", "other_link"]),
  label: Schema.optional(Schema.String),
});
export type LinkedDeviceHold = typeof LinkedDeviceHold.Type;

export const LinkedDeviceListResult = Schema.Struct({
  /** The owner's environment label, which names the group on the linking side. */
  environmentLabel: TrimmedNonEmptyString,
  platforms: Schema.Array(DevicePlatformAvailability),
  agentAccessEnabled: Schema.Boolean,
  /** The agent-device both sides must run: the CLI there talks to the daemon here. */
  agentDeviceVersion: Schema.String,
  devices: Schema.Array(DeviceSummary),
  holds: Schema.Array(LinkedDeviceHold),
});
export type LinkedDeviceListResult = typeof LinkedDeviceListResult.Type;

export const LinkedDeviceOpenInput = Schema.Struct({
  thread: LinkedDeviceThread,
  deviceId: DeviceId,
  platform: DevicePlatform,
  boot: Schema.optional(Schema.Boolean),
  /** An agent opening it, rather than the linking side's user watching. */
  agent: Schema.optional(Schema.Boolean),
});
export type LinkedDeviceOpenInput = typeof LinkedDeviceOpenInput.Type;

export const LinkedDeviceOpenResult = Schema.Struct({
  device: DeviceSummary,
  /** The id agent-device selects the device by on the owner's machine, when it differs. */
  agentDeviceId: Schema.NullOr(Schema.String),
});
export type LinkedDeviceOpenResult = typeof LinkedDeviceOpenResult.Type;

export const LinkedDeviceCloseInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  deviceId: Schema.optional(DeviceId),
  shutdown: Schema.optional(Schema.Boolean),
});
export type LinkedDeviceCloseInput = typeof LinkedDeviceCloseInput.Type;

export const LinkedDeviceHoldInput = Schema.Struct({
  deviceId: DeviceId,
  held: Schema.Boolean,
});
export type LinkedDeviceHoldInput = typeof LinkedDeviceHoldInput.Type;

export const LinkedDeviceScreenshotInput = Schema.Struct({
  thread: LinkedDeviceThread,
  deviceId: DeviceId,
});
export type LinkedDeviceScreenshotInput = typeof LinkedDeviceScreenshotInput.Type;
