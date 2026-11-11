import { EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { DeviceAccessSettings } from "./DeviceAccessSettings";
import "~/index.css";

const mocks = vi.hoisted(() => ({ setAccess: vi.fn(), canEdit: true }));
vi.mock("~/state/device", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    deviceEnvironment: {
      setAccess: { permissionAtom: () => (mocks.canEdit ? allowed : denied) },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.setAccess }));

const environmentId = EnvironmentId.make("environment-a");
const device = (id: string, name: string, physical: boolean) => ({
  hostId: "local",
  id,
  name,
  platform: "android" as const,
  version: "Android 16",
  booted: true,
  physical,
});
const state: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This Mac",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [
    device("emu", "Emulator", false),
    device("pixel", "Pixel", true),
    { ...device("desktop", "Studio (desktop)", true), platform: "desktop", version: "macOS" },
  ],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  supportsDeviceControl: true,
  access: { "local:emu": "deny", "local:gone": "ask", "local:pixel": "sometimes" },
  hubBasePath: "/api/device-hub",
  revision: 1,
};

function setup(canEdit = true) {
  vi.resetAllMocks();
  mocks.canEdit = canEdit;
}

describe("DeviceAccessSettings", () => {
  it("shows each device's policy by label, physical first, and saves a new choice", async () => {
    setup();
    await using screen = await render(
      <DeviceAccessSettings environmentId={environmentId} state={state} />,
    );

    await expect
      .element(screen.getByRole("combobox", { name: "Agent access to Pixel" }))
      .toHaveTextContent("Ask first");
    await expect
      .element(screen.getByRole("combobox", { name: "Agent access to Emulator" }))
      .toHaveTextContent("Never");
    // Only the phone is badged: the computer itself is not a "physical device".
    await expect.element(screen.getByText("Physical", { exact: true })).toBeInTheDocument();
    await expect
      .element(screen.getByText("This Mac · Android 16. Agents cannot use this device."))
      .toBeInTheDocument();

    await screen.getByRole("combobox", { name: "Agent access to Pixel" }).click();
    await screen.getByRole("option", { name: "Allow" }).click();

    expect(mocks.setAccess.mock.calls).toEqual([
      [{ environmentId, input: { hostId: "local", deviceId: "pixel", policy: "allow" } }],
    ]);
  });

  it("resets only a device with a stored choice", async () => {
    setup();
    await using screen = await render(
      <DeviceAccessSettings environmentId={environmentId} state={state} />,
    );

    expect(screen.getByRole("button", { name: /agent access to Pixel/ }).query()).toBeNull();
    await screen.getByRole("button", { name: /agent access to Emulator/ }).click();

    expect(mocks.setAccess.mock.calls).toEqual([
      [{ environmentId, input: { hostId: "local", deviceId: "emu", policy: null } }],
    ]);
  });

  it.each([
    ["the client may not change settings", { ...state }, false, 3],
    ["the server has no device control", { ...state, supportsDeviceControl: false }, true, 0],
    ["no device is known", { ...state, devices: [] }, true, 0],
  ] as const)("is read-only or absent when %s", async (_name, next, canEdit, rows) => {
    setup(canEdit);
    await using screen = await render(
      <DeviceAccessSettings environmentId={environmentId} state={next} />,
    );

    const triggers = screen.getByRole("combobox").elements();
    expect(triggers).toHaveLength(rows);
    for (const trigger of triggers) expect(trigger).toHaveAttribute("data-disabled");
    expect(screen.getByRole("button", { name: /agent access to/ }).query()).toBeNull();
  });
});
