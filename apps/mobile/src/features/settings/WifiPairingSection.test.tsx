import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    can: true,
    start: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-svg", () => ({
  default: (props: { accessibilityLabel: string; children?: ReactNode }) => (
    <svg aria-label={props.accessibilityLabel}>{props.children}</svg>
  ),
  Path: () => null,
  Rect: () => null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.can }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <p>
      {props.label}
      {props.description}
    </p>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "request-1" }));
vi.mock("../../state/device", () => ({
  deviceEnvironment: {
    wifiPairStart: { start: true, permissionAtom: () => "pair-permission" },
    wifiPairCancel: { permissionAtom: () => "cancel-permission" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { start?: boolean }) => (command.start ? mocks.start : mocks.cancel),
}));

import type { DeviceServiceState, EnvironmentId } from "@t3tools/contracts";
import { WifiPairingSection } from "./WifiPairingSection";

const environmentId = "env-a" as EnvironmentId;
const base = {
  hosts: [{ id: "local", label: "Studio Mac" }],
  devices: [],
  supportsWifiPairing: true,
} as unknown as DeviceServiceState;
const attempt = { attemptId: "ADB_WIFI_A", qrPayload: "WIFI:T:ADB;S:ADB_WIFI_A;P:X;;" };
const withPairing = (wifiPairing: object, attemptId = "ADB_WIFI_A") =>
  ({ ...base, wifiPairing: { hostId: "local", attemptId, ...wifiPairing } }) as DeviceServiceState;

async function setup(
  state: DeviceServiceState,
  start: unknown = { _tag: "Success", value: attempt },
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(start);
  mocks.cancel.mockResolvedValue({ _tag: "Success" });
  const container = window.document.createElement("div");
  const root = createRoot(container);
  const show = (next: DeviceServiceState) =>
    act(async () =>
      root.render(<WifiPairingSection environmentId={environmentId} state={next} suffix="" />),
    );
  await show(state);
  return {
    container,
    show,
    press: (label: string) =>
      act(async () =>
        container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
      ),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("Wi-Fi pairing on mobile", () => {
  it("shows the code to scan from the phone, follows each step and cancels", async () => {
    using screen = await setup(base);
    expect(screen.container.textContent).toContain("same Wi-Fi network as Studio Mac");
    await screen.press("Connect a phone over Wi-Fi");

    expect(mocks.start).toHaveBeenCalledWith({ environmentId, input: { requestId: "request-1" } });
    expect(screen.container.querySelector('svg[aria-label="Wi-Fi pairing code"]')).not.toBeNull();
    expect(screen.container.textContent).toContain("open this screen on another device");
    expect(screen.container.textContent).toContain("3. Tap Pair device with QR code");
    expect(screen.container.textContent).toContain("Waiting for your phone to scan the code…");

    await screen.show(withPairing({ status: "pairing" }));
    expect(screen.container.textContent).toContain("Pairing with your phone…");
    await screen.press("Cancel");
    expect(mocks.cancel).toHaveBeenCalledWith({
      environmentId,
      input: { attemptId: "ADB_WIFI_A" },
    });
    expect(
      screen.container.querySelector('button[aria-label="Connect a phone over Wi-Fi"]'),
    ).not.toBeNull();
  });

  it("explains a failure and retries with a fresh attempt", async () => {
    using screen = await setup(base);
    await screen.press("Connect a phone over Wi-Fi");
    await screen.show(withPairing({ status: "failed", reason: "timeout" }));
    expect(screen.container.textContent).toContain("No phone scanned the code in time.");
    await screen.press("Try again");
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("names the connected phone and dismisses the attempt", async () => {
    using screen = await setup(base);
    await screen.press("Connect a phone over Wi-Fi");
    await screen.show({
      ...withPairing({ status: "connected", deviceId: "192.168.1.20:5555" }),
      devices: [{ id: "192.168.1.20:5555", name: "Pixel 7" }],
    } as unknown as DeviceServiceState);
    expect(screen.container.textContent).toContain("Connected to Pixel 7.");
    await screen.press("Done");
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it("offers to cancel another device's attempt and reports other start failures", async () => {
    {
      using screen = await setup(withPairing({ status: "waiting" }, "ADB_WIFI_B"), {
        _tag: "Failure",
        cause: (await import("effect/Cause")).fail({
          _tag: "DeviceWifiPairingBusyError",
          attemptId: "ADB_WIFI_B",
        }),
      });
      await screen.press("Connect a phone over Wi-Fi");
      expect(screen.container.textContent).toContain("Another device is pairing a phone");
      await screen.press("Cancel that attempt");
      expect(mocks.cancel).toHaveBeenCalledWith({
        environmentId,
        input: { attemptId: "ADB_WIFI_B" },
      });
    }
    using screen = await setup(base, {
      _tag: "Failure",
      cause: (await import("effect/Cause")).fail(new Error("Device support is off.")),
    });
    await screen.press("Connect a phone over Wi-Fi");
    expect(screen.container.textContent).toContain("Device support is off.");
  });

  it("is absent on servers without Wi-Fi pairing", async () => {
    using screen = await setup({ ...base, supportsWifiPairing: undefined } as DeviceServiceState);
    expect(screen.container.textContent).toBe("");
  });
});
