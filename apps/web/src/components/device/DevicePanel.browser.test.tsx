import {
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";

import { act, render } from "../../../test/render";

import { DeviceHoldBar } from "./DeviceHoldBar";
import { DevicePanel } from "./DevicePanel";
import "~/index.css";

type CommandResult =
  | { _tag: "Success"; value: { hostId: string; deviceId: string } }
  | { _tag: "Failure"; cause: unknown };
const mocks = vi.hoisted(() => ({
  open: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  close: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  list: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  setHold: vi.fn<(request: unknown) => Promise<CommandResult>>(),
  canHold: true,
  openDevice: vi.fn(),
  closeSurface: vi.fn(),
}));
const phone = {
  hostId: "local",
  id: "phone",
  name: "Phone",
  platform: "ios",
  version: "iOS 19",
  booted: false,
  physical: false,
} as const;
const deviceState: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [{ platform: "ios", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: { local: { status: "ready" } },
  devices: [phone],
  sessions: [
    {
      threadId: ThreadId.make("thread-1"),
      hostId: "local",
      deviceId: "phone",
      platform: "ios",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
let currentState = deviceState;
// One probe per environment, however many views mount it; each probe sends one list.
vi.mock("~/state/device", async () => {
  const Effect = await import("effect/Effect");
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const ALLOWED = Atom.make(true);
  const DENIED = Atom.make(false);
  return {
    deviceEnvironment: {
      list: "list",
      open: "open",
      close: "close",
      setHold: { permissionAtom: () => (mocks.canHold ? ALLOWED : DENIED) },
      wifiPairStart: { permissionAtom: () => ALLOWED },
      wifiPairCancel: "wifiPairCancel",
      forget: { permissionAtom: () => ALLOWED },
    },
    deviceHostProbeAtom: Atom.family((environmentId: string) =>
      Atom.make(() => Effect.promise(() => mocks.list({ environmentId, input: {} }))),
    ),
    NO_DEVICE_PROBE_ATOM: Atom.make(AsyncResult.initial<void, never>()),
    useDeviceState: () => ({ state: currentState, loaded: true }),
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string | object) =>
    command === "open"
      ? mocks.open
      : command === "close"
        ? mocks.close
        : command === "list"
          ? mocks.list
          : typeof command === "object"
            ? mocks.setHold
            : () => Promise.resolve({ _tag: "Success", value: {} }),
}));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Device failed" }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({
      byThreadKey: {},
      openDevice: mocks.openDevice,
      closeSurface: mocks.closeSurface,
    }),
  },
  selectThreadRightPanelState: () => ({ isOpen: false, activeSurfaceId: null, surfaces: [] }),
}));
vi.mock("~/components/device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("~/components/device/DeviceWorkspace", () => ({
  DeviceWorkspace: ({ onPowerOff }: { onPowerOff?: () => void }) =>
    onPowerOff ? <button onClick={onPowerOff}>Power off</button> : <p>Workspace</p>,
}));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => (
    <div className="flex h-full min-h-0 flex-col">{children}</div>
  ),
}));

const threadA = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-1"),
};
// The panel stays mounted across both kinds of switch.
const switches = [
  ["another thread", { environmentId: threadA.environmentId, threadId: ThreadId.make("thread-2") }],
  [
    "the same thread id in another environment",
    { ...threadA, environmentId: EnvironmentId.make("environment-b") },
  ],
] as const;
const threadB = switches[0][1];
const picker: Extract<RightPanelSurface, { kind: "device" }> = { id: "device", kind: "device" };
const phoneTarget = { hostId: "local", deviceId: "phone", platform: "ios", name: "Phone" };
const opened = { _tag: "Success", value: { hostId: "local", deviceId: "phone" } } as const;
const failed = { _tag: "Failure", cause: new Error("boom") } as const;

const deferred = () => {
  let settle!: (result: CommandResult) => void;
  const promise = new Promise<CommandResult>((resolve) => (settle = resolve));
  return { promise, settle };
};

let container: HTMLDivElement;
// Fixed key and a changing threadRef, as RightPanelSurfaceContent mounts it.
const devicePanel = (threadRef: ScopedThreadRef, surface = picker) => (
  <DevicePanel
    key="device-panel"
    mode="embedded"
    threadRef={threadRef}
    surface={surface}
    visible
    onDismissSetup={() => undefined}
  />
);
const startButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Start Phone"]');
const click = (button: HTMLButtonElement | null) =>
  act(async () => {
    button!.click();
  });
const errors = () => container.querySelectorAll('[role="alert"]');

function setup() {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue({ _tag: "Success", value: { hostId: "local", deviceId: "" } });
  currentState = deviceState;
  mocks.canHold = true;
  container = document.createElement("div");
  container.style.width = "480px";
  container.style.height = "800px";
}

describe("DevicePanel thread switches", () => {
  it("keeps the latest pick pending across switches away and back", async () => {
    setup();
    const first = deferred();
    const second = deferred();
    const latest = deferred();
    mocks.open
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    await using screen = await render(devicePanel(threadA), { container });
    await click(startButton());
    await screen.rerender(devicePanel(threadB));
    await click(startButton());
    await screen.rerender(devicePanel(threadA));
    await click(startButton());

    await act(async () => first.settle(failed));

    expect(startButton()).toBeNull();
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice).not.toHaveBeenCalled();

    await act(async () => second.settle(opened));

    expect(startButton()).toBeNull();
    expect(mocks.openDevice.mock.calls).toEqual([[threadB, phoneTarget]]);

    await act(async () => latest.settle(opened));

    expect(startButton()?.disabled).toBe(false);
    expect(errors()).toHaveLength(0);
    expect(mocks.openDevice.mock.calls).toEqual([
      [threadB, phoneTarget],
      [threadA, phoneTarget],
    ]);
  });
});

describe("DevicePanel host probe", () => {
  it("probes the hosts once while setup shows inside the panel", async () => {
    setup();
    currentState = { ...deviceState, onboardingCompleted: false };
    // An environment no other test probed, so its probe starts fresh.
    const threadRef = { ...threadA, environmentId: EnvironmentId.make("environment-setup") };
    await using _screen = await render(devicePanel(threadRef), { container });

    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(mocks.list.mock.calls).toEqual([
      [{ environmentId: threadRef.environmentId, input: {} }],
    ]);
  });
});

describe("DevicePanel discovery warning", () => {
  it("a dismissal hides only the cause it was made for", async () => {
    setup();
    const withCause = (detail: string): DeviceServiceState => ({
      ...deviceState,
      hostStatuses: { local: { status: "ready", detail, incompletePlatforms: ["ios"] } },
    });
    const warning = "iOS list on This Mac may be incomplete.";
    currentState = withCause("first cause");
    await using screen = await render(devicePanel(threadA), { container });

    await screen.getByRole("button", { name: "Dismiss device warning for This Mac" }).click();
    await screen.rerender(devicePanel(threadA));
    await expect.element(screen.getByText(warning)).not.toBeInTheDocument();

    currentState = withCause("second cause");
    await screen.rerender(devicePanel(threadA));
    await expect.element(screen.getByText(warning)).toBeVisible();
  });
});

describe("DevicePanel takeover and physical devices", () => {
  const pixel = {
    hostId: "local",
    id: "pixel",
    name: "Pixel",
    platform: "android",
    version: "Android 16",
    booted: true,
    physical: true,
  } as const;
  const hold = { hostId: "local", deviceId: "pixel", since: "2026-01-01T00:00:00.000Z" };
  const held = (deviceId: string) => ({ ...hold, deviceId });
  const withControl = (extra: Partial<DeviceServiceState>): DeviceServiceState => ({
    ...deviceState,
    supportsDeviceControl: true,
    devices: [phone, pixel],
    ...extra,
  });
  const active = (deviceId: string): Extract<RightPanelSurface, { kind: "device" }> => ({
    id: "device",
    kind: "device",
    target: { hostId: "local", deviceId, platform: "ios", name: deviceId },
  });

  it("lists physical devices apart, without a start action, and hands a held one back", async () => {
    setup();
    currentState = withControl({
      holds: [hold],
      devices: [phone, { ...pixel, connection: "wifi" }],
    });
    await using screen = await render(devicePanel(threadA), { container });

    const headings = [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Physical devices", "iOS Simulators"]);
    await expect.element(screen.getByText("Physical", { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open Pixel" })).toBeInTheDocument();
    await expect
      .element(screen.getByText(/Wi-Fi · Connected · You are in control/))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Forget Pixel" })).toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Hand back Pixel" }).click();

    expect(mocks.setHold.mock.calls).toEqual([
      [
        {
          environmentId: threadA.environmentId,
          input: { hostId: "local", deviceId: "pixel", held: false },
        },
      ],
    ]);
  });

  it.each([
    [
      "offers Take over while agents can drive it",
      [],
      "Agents can use this device",
      "Take over",
      true,
    ],
    [
      "shows the paused state with Hand back while held",
      [held("phone")],
      "You are in control. Agent paused.",
      "Hand back",
      false,
    ],
  ] as const)("%s", async (_name, holds, status, action, nextHeld) => {
    setup();
    currentState = withControl({ holds: [...holds] });
    await using screen = await render(devicePanel(threadA, active("phone")), { container });

    await expect.element(screen.getByText(status)).toBeInTheDocument();
    await screen.getByRole("button", { name: action }).click();

    expect(mocks.setHold.mock.calls).toEqual([
      [
        {
          environmentId: threadA.environmentId,
          input: { hostId: "local", deviceId: "phone", held: nextHeld },
        },
      ],
    ]);
    await expect.element(screen.getByRole("button", { name: "Power off" })).toBeInTheDocument();
  });

  it("offers no power off and no takeover row for a physical device agents cannot reach", async () => {
    setup();
    currentState = withControl({
      agentAccessEnabled: false,
      sessions: [{ ...deviceState.sessions[0]!, deviceId: "pixel", platform: "android" }],
    });
    await using screen = await render(devicePanel(threadA, active("pixel")), { container });

    await expect.element(screen.getByText("Workspace")).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Power off" }).query()).toBeNull();
  });

  it.each([
    ["a physical device asks first", {}, false, "Agents ask before using this device", "Take over"],
    [
      "a denied device offers no takeover",
      { access: { "local:pixel": "deny" } },
      false,
      "Agents cannot use this device",
      null,
    ],
    ["the floating preview stays clear until held", {}, true, null, null],
    [
      "the floating preview shows the held state",
      { holds: [hold] },
      true,
      "You are in control. Agent paused.",
      "Hand back",
    ],
  ] as const)("hold bar: %s", async (_name, extra, heldOnly, status, action) => {
    setup();
    mocks.canHold = false;
    await using screen = await render(
      <DeviceHoldBar
        environmentId={threadA.environmentId}
        state={withControl(extra)}
        device={pixel}
        heldOnly={heldOnly}
      />,
      { container },
    );

    expect(container.querySelector('[role="status"]')?.textContent ?? null).toBe(
      status === null ? null : `${status}${action ?? ""}`,
    );
    // Without the operate grant the switch is shown but cannot be pressed.
    if (action) await expect.element(screen.getByRole("button", { name: action })).toBeDisabled();
  });
});

describe("DevicePanel capture devices", () => {
  const desktop = {
    hostId: "local",
    id: "desktop",
    name: "Ana's Mac (desktop)",
    platform: "desktop",
    version: "macOS",
    booted: true,
    physical: true,
  } as const;
  const usbPhone = {
    hostId: "local",
    id: "UDID-1",
    name: "Ana's iPhone",
    platform: "ios",
    version: "iOS 19",
    booted: true,
    physical: true,
    connection: "usb",
  } as const;
  const withDevices = (...devices: DeviceServiceState["devices"]): DeviceServiceState => ({
    ...deviceState,
    supportsDeviceControl: true,
    devices,
  });

  it("groups this computer apart and lists every issue with its fix", async () => {
    setup();
    currentState = withDevices(
      { ...desktop, issues: [{ reason: "screen_recording_permission" }] },
      {
        ...usbPhone,
        issues: [{ reason: "camera_permission" }, { reason: "signing_missing", detail: "no team" }],
      },
      phone,
    );
    await using screen = await render(devicePanel(threadA), { container });

    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "This computer",
      "Physical devices",
      "iOS Simulators",
    ]);
    await expect.element(screen.getByText("Screen Recording permission is off")).toBeVisible();
    await expect.element(screen.getByText("Camera permission is off")).toBeVisible();
    await expect.element(screen.getByText("iPhone signing is not set up")).toBeVisible();
    await expect.element(screen.getByText("no team")).toBeVisible();
    await expect.element(screen.getByText("This Mac · macOS · Not ready")).toBeVisible();
    const links = screen.getByRole("link", { name: "Open Mac permissions" });
    await expect.element(links).toHaveAttribute("href", "/settings/mac-permissions");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("cannot open a device whose view is blocked, but can open one blocked only for control", async () => {
    setup();
    mocks.open.mockResolvedValue({
      _tag: "Success",
      value: { hostId: "local", deviceId: "desktop" },
    });
    currentState = withDevices(
      { ...desktop, issues: [{ reason: "screen_recording_permission" }] },
      { ...usbPhone, issues: [{ reason: "signing_missing" }] },
    );
    await using screen = await render(devicePanel(threadA), { container });

    await expect
      .element(screen.getByRole("button", { name: "Open Ana's Mac (desktop)" }))
      .toBeDisabled();
    await screen.getByRole("button", { name: "Open Ana's iPhone" }).click();

    expect(mocks.open.mock.calls).toHaveLength(1);
    expect(mocks.open.mock.calls[0]).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ deviceId: "UDID-1", platform: "ios" }),
      }),
    ]);
  });

  it("offers Take over and Hand back for a capture device", async () => {
    setup();
    const surface: Extract<RightPanelSurface, { kind: "device" }> = {
      id: "device",
      kind: "device",
      target: { hostId: "local", deviceId: "desktop", platform: "desktop", name: desktop.name },
    };
    currentState = {
      ...withDevices(desktop),
      sessions: [{ ...deviceState.sessions[0]!, deviceId: "desktop", platform: "desktop" }],
    };
    await using screen = await render(devicePanel(threadA, surface), { container });

    await screen.getByRole("button", { name: "Take over" }).click();
    expect(mocks.setHold.mock.calls[0]![0]).toMatchObject({
      input: { deviceId: "desktop", held: true },
    });
  });
});
