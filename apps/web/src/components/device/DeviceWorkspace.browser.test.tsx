import { EnvironmentId, type DeviceSummary } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { DeviceWorkspace } from "./DeviceWorkspace";
import "~/index.css";

const mocks = vi.hoisted(() => ({ streamProps: [] as Array<Record<string, unknown>> }));
vi.mock("~/state/device", () => ({
  useDeviceHubAccess: () => null,
  refreshDeviceHubAccess: () => undefined,
}));
vi.mock("./useDeviceControls", () => ({
  useDeviceControls: () => ({ disabled: true, detail: null, error: null, act: vi.fn() }),
}));
vi.mock("./DeviceToolsPanel", () => ({ DeviceToolsPanel: () => <p>Tools drawer</p> }));
vi.mock("./DeviceStreamView", () => ({
  DeviceStreamView: (props: {
    renderControls: (view: unknown) => ReactNode;
    [key: string]: unknown;
  }) => {
    mocks.streamProps.push(props);
    return props.renderControls({
      phone: false,
      streaming: true,
      phoneUnavailableReason: null,
      showPhone: () => undefined,
      showFlat: () => undefined,
      resetView: () => undefined,
      keyboard: null,
      handle: null,
    });
  },
}));

const device = (overrides: Partial<DeviceSummary>): DeviceSummary => ({
  hostId: "local",
  id: "d",
  name: "Device",
  platform: "ios",
  version: "iOS 19",
  booted: true,
  physical: false,
  ...overrides,
});

function workspace(target: DeviceSummary) {
  return (
    <DeviceWorkspace
      environmentId={EnvironmentId.make("env")}
      device={target}
      hostLabel="This Mac"
      hostKind="local"
      hostDiagnostics={undefined}
      visible
      onFloat={() => undefined}
      onClose={() => undefined}
    />
  );
}

describe("DeviceWorkspace view-only capture sources", () => {
  it.each([
    [
      "desktop",
      device({ id: "desktop", platform: "desktop", physical: true, version: "macOS" }),
      "View only. Agents use computer tools on this computer.",
    ],
    [
      "usb iphone",
      device({ id: "UDID", physical: true, connection: "usb" }),
      "View only. Use the phone to control it.",
    ],
  ])("%s shows the notice and no input controls", async (_name, target, notice) => {
    mocks.streamProps.length = 0;
    await using screen = await render(workspace(target), { router: false });

    await expect.element(screen.getByText(notice)).toBeVisible();
    expect(mocks.streamProps.at(-1)).toMatchObject({ captureSource: true });
    for (const name of ["Home", "Device tools", "Save screenshot", "3D view", "Flat view"])
      expect(screen.getByRole("button", { name }).query()).toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "More device actions" }))
      .toBeInTheDocument();
    expect(screen.getByText("Tools drawer").query()).toBeNull();
  });

  it("a simulator keeps its input controls and no notice", async () => {
    mocks.streamProps.length = 0;
    await using screen = await render(workspace(device({})), { router: false });

    expect(mocks.streamProps.at(-1)).toMatchObject({ captureSource: false });
    await expect.element(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Device tools" })).toBeInTheDocument();
    expect(screen.getByText(/View only/).query()).toBeNull();
  });
});
