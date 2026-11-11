import { EnvironmentId, type DeviceSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { DeviceWorkspace } from "./DeviceWorkspace";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  streamProps: [] as Array<Record<string, unknown>>,
  run: (..._args: ReadonlyArray<unknown>): Promise<unknown> =>
    Promise.resolve({ _tag: "Success", value: undefined }),
}));
vi.mock("~/state/device", () => ({
  useDeviceHubAccess: () => null,
  refreshDeviceHubAccess: () => undefined,
  deviceEnvironment: { input: { label: "device:input" } },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAtomCommand: (...args: ReadonlyArray<unknown>) => mocks.run(...args),
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

function workspace(target: DeviceSummary, supportsPhoneControl?: boolean) {
  return (
    <DeviceWorkspace
      environmentId={EnvironmentId.make("env")}
      device={target}
      hostLabel="This Mac"
      hostKind="local"
      hostDiagnostics={undefined}
      supportsPhoneControl={supportsPhoneControl}
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
    [
      "usb iphone that is not ready",
      device({ id: "UDID", physical: true, issues: [{ reason: "signing_missing" }] }),
      "iPhone signing is not set up",
    ],
  ])("%s shows the notice and no input controls", async (_name, target, notice) => {
    mocks.streamProps.length = 0;
    await using screen = await render(workspace(target, _name !== "usb iphone"), {
      router: false,
    });

    await expect.element(screen.getByText(notice)).toBeVisible();
    expect(mocks.streamProps.at(-1)).toMatchObject({
      captureSource: true,
      phoneControl: undefined,
    });
    for (const name of [
      "Home",
      "App switcher",
      "Device tools",
      "Save screenshot",
      "3D view",
      "Flat view",
    ])
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

describe("DeviceWorkspace USB iPhone control", () => {
  it("sends the user's input in order, shows a slow one as pending, and shows a failure", async () => {
    mocks.streamProps.length = 0;
    const sent: unknown[] = [];
    const replies: Array<(reply: unknown) => void> = [];
    mocks.run = (_registry, _command, value) => {
      sent.push((value as { input: { input: unknown } }).input.input);
      return new Promise((reply) => replies.push(reply));
    };
    await using screen = await render(
      workspace(device({ id: "UDID", physical: true, connection: "usb", issues: [] }), true),
      { router: false },
    );

    expect(screen.getByText(/View only/).query()).toBeNull();
    const control = mocks.streamProps.at(-1)?.phoneControl as {
      touch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
      key: (event: KeyboardEvent) => boolean;
    };
    expect(control.key(new KeyboardEvent("keydown", { key: "a" }))).toBe(true);
    expect(control.key(new KeyboardEvent("keydown", { key: "Shift" }))).toBe(false);
    control.touch("begin", 0.5, 0.5);
    control.touch("end", 0.5, 0.5);
    await expect.element(screen.getByText("Sending to the phone…")).toBeInTheDocument();
    expect(sent).toEqual([{ type: "text", text: "a" }]);
    replies[0]!({ _tag: "Success", value: undefined });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ type: "tap", x: 0.5, y: 0.5 });
    replies[1]!({ _tag: "Failure", cause: Cause.fail(new Error("The phone is locked.")) });
    await expect.element(screen.getByRole("alert")).toHaveTextContent("The phone is locked.");
    expect(screen.getByText("Sending to the phone…").query()).toBeNull();

    await screen.getByRole("button", { name: "App switcher" }).click();
    await vi.waitFor(() => expect(sent[2]).toEqual({ type: "button", button: "appSwitcher" }));
    replies[2]!({ _tag: "Success", value: undefined });
    await vi.waitFor(() => expect(screen.getByRole("alert").query()).toBeNull());
    await screen.getByRole("button", { name: "Home" }).click();
    await vi.waitFor(() => expect(sent[3]).toEqual({ type: "button", button: "home" }));
  });
});
