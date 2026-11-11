import {
  DeviceHostId,
  DeviceId,
  DeviceNotReadyError,
  EnvironmentId,
  ThreadId,
  type DeviceServiceState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
  answer: vi.fn<(request: unknown) => Promise<CommandResult>>(),
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
      answerLinkRequest: { kind: "answer", permissionAtom: () => ALLOWED },
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
          : typeof command === "object" && "kind" in command
            ? mocks.answer
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
const failed = { _tag: "Failure", cause: Cause.fail(new Error("boom")) } as const;

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

  const studio = {
    id: "linked.env-studio",
    kind: "linked",
    label: "Studio Mac",
    environmentId: "env-studio",
    linkState: "connected",
    platforms: [{ platform: "android", available: true }],
    hubInstalled: true,
    agentDeviceInstalled: true,
  } as const;
  const galaxy = { ...pixel, hostId: studio.id, id: "R5CX", name: "Galaxy" } as const;

  it.each([
    [
      "a linked device the owner holds",
      { holds: [{ ...held("R5CX"), hostId: studio.id, linked: { label: "Studio Mac" } }] },
      "Studio Mac is in control. Agents paused.",
      null,
    ],
    [
      "a linked device nobody holds",
      {},
      "Agents follow Studio Mac's access settings for this device",
      "Take over",
    ],
  ] as const)("hold bar: %s", async (_name, extra, status, action) => {
    setup();
    await using _screen = await render(
      <DeviceHoldBar
        environmentId={threadA.environmentId}
        state={withControl({ hosts: [...deviceState.hosts, studio], devices: [galaxy], ...extra })}
        device={galaxy}
      />,
      { container },
    );

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      `${status}${action ?? ""}`,
    );
  });
});

describe("DevicePanel linked environments", () => {
  const studio = {
    id: "linked.env-studio",
    kind: "linked",
    label: "Studio Mac",
    environmentId: "env-studio",
    linkState: "connected",
    platforms: [{ platform: "android", available: true }],
    hubInstalled: true,
    agentDeviceInstalled: true,
  } as const;
  const attic = {
    ...studio,
    id: "linked.env-attic",
    label: "Attic PC",
    environmentId: "env-attic",
    linkState: "link_down",
    linkDetail: "Attic PC is not reachable over the link: No address answered.",
  } as const;
  const galaxy = {
    hostId: studio.id,
    id: "R5CX",
    name: "Galaxy",
    platform: "android",
    version: "Android 16",
    booted: true,
    physical: true,
  } as const;
  const atticPhone = { ...galaxy, hostId: attic.id, id: "ATTIC", name: "Old Pixel" } as const;

  it("lists each linked environment's devices under its name and state", async () => {
    setup();
    // As the server emits a dead link: only that host failed, and its last devices stay listed.
    currentState = {
      ...deviceState,
      hosts: [...deviceState.hosts, attic, studio],
      hostStatuses: {
        ...deviceState.hostStatuses,
        [studio.id]: { status: "ready" },
        [attic.id]: { status: "failed", detail: attic.linkDetail },
      },
      devices: [phone, galaxy, atticPhone],
    };
    await using screen = await render(devicePanel(threadA), { container });

    const headings = [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["iOS Simulators", "Attic PC", "Studio Mac"]);
    await expect.element(screen.getByText("Connected", { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText("Link down", { exact: true })).toBeInTheDocument();
    await expect.element(screen.getByText(attic.linkDetail)).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open Galaxy" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Open Old Pixel" })).toBeDisabled();
    await expect.element(screen.getByText("Physical", { exact: true }).first()).toBeInTheDocument();
  });

  it("lists a linked environment while this machine's hub failed, and says why", async () => {
    setup();
    currentState = {
      ...deviceState,
      hostStatus: "failed",
      hostStatusDetail: "Xcode is not installed.",
      hostStatuses: { local: { status: "failed" }, [studio.id]: { status: "ready" } },
      hosts: [...deviceState.hosts, studio],
      devices: [galaxy],
    };
    await using screen = await render(devicePanel(threadA), { container });

    await expect.element(screen.getByText("Xcode is not installed.")).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Open Galaxy" })).toBeEnabled();
  });

  it("says a connected linked environment has no devices, and shows nothing without links", async () => {
    setup();
    currentState = { ...deviceState, hosts: [...deviceState.hosts, studio] };
    await using screen = await render(devicePanel(threadA), { container });
    await expect.element(screen.getByText("No devices on Studio Mac.")).toBeInTheDocument();

    currentState = deviceState;
    await screen.rerender(devicePanel(threadA));
    await expect.element(screen.getByText("Studio Mac")).not.toBeInTheDocument();
  });

  it("shows the owner who uses a device from a link, and answers a link's request", async () => {
    setup();
    mocks.answer.mockResolvedValue({ _tag: "Success", value: { hostId: "", deviceId: "" } });
    currentState = {
      ...deviceState,
      sessions: [
        {
          ...deviceState.sessions[0]!,
          threadId: ThreadId.make("linked:link-1:thread-9"),
          linked: { label: "Laptop", threadTitle: "Fix login" },
        },
      ],
      holds: [
        {
          hostId: "local",
          deviceId: "phone",
          since: "2026-01-01T00:00:00.000Z",
          linked: { label: "Laptop" },
        },
      ],
      linkRequests: [
        {
          requestId: "r-1",
          linkLabel: "Laptop",
          threadTitle: "Fix login",
          hostId: "local",
          deviceId: "phone",
          deviceName: "Phone",
        },
      ],
    };
    await using screen = await render(devicePanel(threadA), { container });

    await expect
      .element(screen.getByText(/Laptop is in control · Used by “Fix login” on Laptop/))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("“Fix login” on Laptop wants to use Phone."))
      .toBeInTheDocument();
    await screen.getByRole("button", { name: "Allow", exact: true }).click();
    await screen.getByRole("button", { name: "Don't allow" }).click();
    expect(mocks.answer.mock.calls).toEqual([
      [{ environmentId: threadA.environmentId, input: { requestId: "r-1", allow: true } }],
      [{ environmentId: threadA.environmentId, input: { requestId: "r-1", allow: false } }],
    ]);
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
    await expect.element(screen.getByText("This Mac · iOS 19 · USB · Not ready")).toBeVisible();
    const links = screen.getByRole("link", { name: "Open Mac permissions" });
    await expect.element(links).toHaveAttribute("href", "/settings/mac-permissions");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("opens a device again after its video failed, without showing the agent's refusal", async () => {
    setup();
    mocks.open.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new DeviceNotReadyError({
          hostId: DeviceHostId.make("local"),
          deviceId: DeviceId.make("desktop"),
          deviceName: "Ana's Mac (desktop)",
          reason: "capture_failed",
        }),
      ),
    });
    currentState = withDevices({ ...desktop, issues: [{ reason: "capture_failed" }] });
    await using screen = await render(devicePanel(threadA), { container });

    await expect.element(screen.getByText("This Mac · macOS · Not ready")).toBeVisible();
    await screen.getByRole("button", { name: "Open Ana's Mac (desktop)" }).click();

    expect(mocks.open.mock.calls).toHaveLength(1);
    await expect.element(screen.getByText("Live video failed")).toBeVisible();
    expect(container.textContent).not.toContain("Only the user can fix this");
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
