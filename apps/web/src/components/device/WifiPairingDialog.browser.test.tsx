import { DeviceId, EnvironmentId, type DeviceServiceState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { ForgetWifiDeviceButton, WifiPairingButton } from "./WifiPairingDialog";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  forget: vi.fn(),
  allowed: true,
}));
vi.mock("~/state/device", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  const permissionAtom = () => (mocks.allowed ? allowed : denied);
  return {
    deviceEnvironment: {
      wifiPairStart: { permissionAtom, run: () => mocks.start },
      wifiPairCancel: { permissionAtom, run: () => mocks.cancel },
      forget: { permissionAtom, run: () => mocks.forget },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { run: () => unknown }) => command.run(),
}));

const environmentId = EnvironmentId.make("environment-a");
const phone = {
  hostId: "local",
  id: "192.168.1.20:41233",
  name: "Pixel 7",
  platform: "android" as const,
  version: "Android 16",
  booted: true,
  physical: true,
  connection: "wifi" as const,
};
const base: DeviceServiceState = {
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "Studio Mac",
      platforms: [],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [phone],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  supportsWifiPairing: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const attempt = { attemptId: "ADB_WIFI_A", qrPayload: "WIFI:T:ADB;S:ADB_WIFI_A;P:SECRET;;" };
// The start answers with a state newer than the one rendered, as the stream lags it.
const started = { ...attempt, state: { revision: 2 } };
const withPairing = (
  wifiPairing: Omit<NonNullable<DeviceServiceState["wifiPairing"]>, "hostId" | "attemptId">,
  attemptId = attempt.attemptId,
): DeviceServiceState => ({ ...base, wifiPairing: { hostId: "local", attemptId, ...wifiPairing } });

function setup(start: () => unknown = () => ({ _tag: "Success", value: started }), allowed = true) {
  vi.resetAllMocks();
  mocks.allowed = allowed;
  mocks.start.mockImplementation(async () => start());
  mocks.cancel.mockResolvedValue({ _tag: "Success" });
  mocks.forget.mockResolvedValue({ _tag: "Success" });
}

const pairingButton = (state: DeviceServiceState) => (
  <WifiPairingButton environmentId={environmentId} state={state} />
);

describe("Connect a phone over Wi-Fi", () => {
  it("shows the code, the phone steps and each live step, and cancels the attempt", async () => {
    setup();
    await using screen = await render(pairingButton(base));
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();

    await expect
      .element(screen.getByRole("img", { name: "Wi-Fi pairing code" }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByText("Tap Pair device with QR code and scan this code."))
      .toBeInTheDocument();
    await expect.element(screen.getByText(/same Wi-Fi network as Studio Mac/)).toBeInTheDocument();
    await expect
      .element(screen.getByText("Waiting for your phone to scan the code…"))
      .toBeInTheDocument();
    expect(mocks.start.mock.calls[0]?.[0]).toMatchObject({ environmentId, input: {} });

    await screen.rerender(pairingButton(withPairing({ status: "connecting" })));
    await expect.element(screen.getByText("Connecting to your phone…")).toBeInTheDocument();

    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(mocks.cancel.mock.calls).toEqual([
      [{ environmentId, input: { attemptId: attempt.attemptId } }],
    ]);
  });

  it("names the paired phone, then dismisses the finished attempt", async () => {
    setup();
    await using screen = await render(pairingButton(base));
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();
    await screen.rerender(
      pairingButton(withPairing({ status: "connected", deviceId: DeviceId.make(phone.id) })),
    );

    await expect.element(screen.getByText("Connected to Pixel 7.")).toBeInTheDocument();
    await screen.getByRole("button", { name: "Done" }).click();
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it("explains a failure with adb's words and starts a fresh attempt on retry", async () => {
    setup();
    await using screen = await render(pairingButton(base));
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();
    await screen.rerender(
      pairingButton(
        withPairing({ status: "failed", reason: "wrong_network", detail: "No route to host" }),
      ),
    );

    await expect
      .element(screen.getByText(/Put it on the same Wi-Fi network as the host/))
      .toBeInTheDocument();
    await expect.element(screen.getByText("No route to host")).toBeInTheDocument();
    await screen.getByRole("button", { name: "Try again" }).click();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });

  it("offers to cancel another client's attempt instead of a dead end", async () => {
    setup(() => ({
      _tag: "Failure",
      cause: Cause.fail({ _tag: "DeviceWifiPairingBusyError", attemptId: "ADB_WIFI_B" }),
    }));
    await using screen = await render(
      pairingButton(withPairing({ status: "waiting" }, "ADB_WIFI_B")),
    );
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();

    await expect.element(screen.getByText("Another device is pairing a phone")).toBeInTheDocument();
    await screen.getByRole("button", { name: "Cancel that attempt" }).click();
    expect(mocks.cancel.mock.calls[0]).toEqual([
      { environmentId, input: { attemptId: "ADB_WIFI_B" } },
    ]);
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
  });

  it("releases an attempt whose start answers after the dialog closed", async () => {
    let answer: (value: unknown) => void = () => undefined;
    setup(() => new Promise((resolve) => (answer = resolve)));
    await using screen = await render(pairingButton(base));
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(mocks.cancel).not.toHaveBeenCalled();

    answer({ _tag: "Success", value: started });
    await vi.waitFor(() =>
      expect(mocks.cancel.mock.calls).toEqual([
        [{ environmentId, input: { attemptId: attempt.attemptId } }],
      ]),
    );
  });

  it("offers a retry when another client cancels this attempt", async () => {
    setup();
    await using screen = await render(pairingButton({ ...base, revision: 2 }));
    await screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).click();
    await expect
      .element(screen.getByText("Pairing was cancelled on another device."))
      .toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("is locked without permission and absent on servers without Wi-Fi pairing", async () => {
    setup(undefined, false);
    {
      await using screen = await render(pairingButton(base));
      await expect
        .element(screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }))
        .toBeDisabled();
    }
    await using screen = await render(pairingButton({ ...base, supportsWifiPairing: undefined }));
    expect(screen.getByRole("button", { name: "Connect a phone over Wi-Fi" }).query()).toBeNull();
  });

  it("forgets a Wi-Fi phone", async () => {
    setup();
    await using screen = await render(
      <ForgetWifiDeviceButton environmentId={environmentId} device={phone} />,
    );
    await screen.getByRole("button", { name: "Forget Pixel 7" }).click();
    expect(mocks.forget.mock.calls).toEqual([
      [{ environmentId, input: { hostId: "local", deviceId: phone.id } }],
    ]);
  });
});
