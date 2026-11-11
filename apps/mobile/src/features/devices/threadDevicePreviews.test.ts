import { ThreadId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deviceHoldMenuItem,
  selectedThreadDevicePreview,
  threadDevicePreviews,
} from "./threadDevicePreviews";

const threadId = ThreadId.make("thread");
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Local",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
    {
      id: "remote",
      kind: "ssh",
      label: "Mac mini",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    {
      hostId: "local",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 9",
      version: "Android 16",
      booted: true,
      physical: false,
    },
    {
      hostId: "remote",
      id: "emulator-5554",
      platform: "android",
      name: "Pixel 8",
      version: "Android 15",
      booted: true,
      physical: false,
    },
  ],
  sessions: [
    {
      threadId,
      hostId: "local",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:00:00Z",
    },
    {
      threadId,
      hostId: "remote",
      deviceId: "emulator-5554",
      platform: "android",
      openedAt: "2026-09-18T00:01:00Z",
    },
    {
      threadId: ThreadId.make("another-thread"),
      hostId: "local",
      deviceId: "iphone",
      platform: "ios",
      openedAt: "2026-09-18T00:02:00Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};

describe("thread device previews", () => {
  it("keeps device names and selection distinct when hosts have the same Android serial", () => {
    const previews = threadDevicePreviews(state, threadId);
    expect(previews.map((preview) => preview.name)).toEqual(["Pixel 9", "Pixel 8"]);
    expect(new Set(previews.map((preview) => preview.key)).size).toBe(2);
    expect(selectedThreadDevicePreview(previews, previews[1]!.key)?.description).toBe(
      "Android 15 · Mac mini",
    );
  });

  it("marks a physical device and one the user holds, on the host that holds it", () => {
    const previews = threadDevicePreviews(
      {
        ...state,
        supportsDeviceControl: true,
        devices: [{ ...state.devices[0]!, physical: true }, state.devices[1]!],
        holds: [{ hostId: "remote", deviceId: "emulator-5554", since: "2026-09-18T00:03:00Z" }],
      },
      threadId,
    );
    expect(
      previews.map(({ description, physical, held, canHold }) => ({
        description,
        physical,
        held,
        canHold,
      })),
    ).toEqual([
      { description: "Physical · Android 16 · Local", physical: true, held: false, canHold: true },
      { description: "Android 15 · Mac mini", physical: false, held: true, canHold: true },
    ]);
    expect(threadDevicePreviews(state, threadId)[0]).toMatchObject({ canHold: false, held: false });
    expect(previews.map((preview) => deviceHoldMenuItem(preview, true))).toMatchObject([
      { title: "Take over", nextHeld: true, disabled: false },
      { title: "Hand back to the agent", nextHeld: false, disabled: false },
    ]);
    expect(deviceHoldMenuItem(previews[0]!, false)?.disabled).toBe(true);
    expect(deviceHoldMenuItem(threadDevicePreviews(state, threadId)[0]!, true)).toBeNull();
    expect(deviceHoldMenuItem(null, true)).toBeNull();
  });

  it("labels the desktop and a USB iPhone, marks them view-only and surfaces their issues", () => {
    const desktop = {
      hostId: "local",
      id: "desktop",
      platform: "desktop" as const,
      name: "Ana's Mac (desktop)",
      version: "",
      booted: true,
      physical: false,
      issues: [{ reason: "wayland_unsupported" as const }],
    };
    const iphone = {
      hostId: "local",
      id: "iphone",
      platform: "ios" as const,
      name: "Ana's iPhone",
      version: "iOS 19",
      booted: true,
      physical: true,
      connection: "usb" as const,
      issues: [{ reason: "developer_mode_off" as const }, { reason: "capture_failed" as const }],
    };
    const session = (deviceId: string, platform: "ios" | "desktop") => ({
      threadId,
      hostId: "local",
      deviceId,
      platform,
      openedAt: "2026-09-18T00:00:00Z",
    });
    const previews = threadDevicePreviews(
      {
        ...state,
        devices: [desktop, iphone],
        sessions: [
          session("desktop", "desktop"),
          session("iphone", "ios"),
          session("gone", "desktop"),
        ],
      },
      threadId,
    );
    expect(previews.map((preview) => preview.name)).toEqual([
      "Ana's Mac (desktop)",
      "Ana's iPhone",
      "This computer",
    ]);
    expect(previews[0]).toMatchObject({
      description: "This computer · Local",
      capture: true,
      viewOnlyNotice: "View only. Agents use computer tools on this computer.",
      blocked: { title: "Live video is not available on Wayland" },
    });
    expect(previews[1]).toMatchObject({
      description: "Physical · USB · iOS 19 · Local",
      capture: true,
      viewOnlyNotice: "View only. Use the phone to control it.",
      blocked: null,
    });
    // A failed start does not block: opening again is how the user retries it.
    expect(previews[1]!.issues).toMatchObject([
      { title: "Developer Mode is off", blocksView: false, action: expect.any(String) },
      { title: "Live video failed", blocksView: true },
    ]);
    expect(previews[2]).toMatchObject({ capture: false, viewOnlyNotice: null, issues: [] });
    expect(previews.map((preview) => preview.phoneControl)).toEqual([false, false, false]);

    // With phone input, the iPhone's blocking issue row is the notice; once fixed it is controllable.
    const withControl = {
      ...state,
      supportsPhoneControl: true,
      sessions: [session("iphone", "ios")],
    };
    expect(threadDevicePreviews({ ...withControl, devices: [iphone] }, threadId)[0]).toMatchObject({
      phoneControl: false,
      viewOnlyNotice: null,
    });
    expect(
      threadDevicePreviews({ ...withControl, devices: [{ ...iphone, issues: [] }] }, threadId)[0],
    ).toMatchObject({ phoneControl: true, viewOnlyNotice: null });
    // A locked phone's row stops the video, so DeviceNotices hides it: the notice names it instead.
    expect(
      threadDevicePreviews(
        { ...withControl, devices: [{ ...iphone, issues: [{ reason: "locked" as const }] }] },
        threadId,
      )[0],
    ).toMatchObject({ phoneControl: false, viewOnlyNotice: "Locked" });
    expect(threadDevicePreviews(state, threadId)[0]).toMatchObject({
      capture: false,
      blocked: null,
    });
    expect(deviceHoldMenuItem(previews[1]!, true)).toBeNull();
  });

  it.each([
    ["a linked environment's owner", "linked", { heldBy: "Studio", heldThere: true }, true],
    ["a link's user, on this owner's device", "ssh", { heldBy: "Studio", heldThere: false }, false],
  ] as const)("names a hold by %s", (_name, kind, expected, locked) => {
    const [preview] = threadDevicePreviews(
      {
        ...state,
        supportsDeviceControl: true,
        hosts: state.hosts.map((host) =>
          host.id === "remote"
            ? kind === "linked"
              ? { ...host, kind, environmentId: "env-studio", linkState: "connected" as const }
              : host
            : host,
        ),
        sessions: [state.sessions[1]!],
        holds: [
          {
            hostId: "remote",
            deviceId: "emulator-5554",
            since: "2026-09-18T00:03:00Z",
            linked: { label: "Studio" },
          },
        ],
      },
      threadId,
    );
    expect(preview).toMatchObject({ held: true, ...expected });
    expect(deviceHoldMenuItem(preview!, true)?.disabled).toBe(locked);
  });

  it("selects another open device when the agent closes the selected session", () => {
    const previews = threadDevicePreviews(state, threadId);
    const selectedKey = previews[1]!.key;
    const afterClose = threadDevicePreviews({ ...state, sessions: [state.sessions[0]!] }, threadId);
    expect(selectedThreadDevicePreview(afterClose, selectedKey)?.name).toBe("Pixel 9");
    expect(selectedThreadDevicePreview([], selectedKey)).toBeNull();
  });
});
