import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["env-a"] as string[],
    data: null as unknown,
    error: null as string | null,
    can: true,
    probe: { _tag: "Success" } as unknown,
    setAccess: vi.fn(),
    setHold: vi.fn(),
    forget: vi.fn(),
    answer: vi.fn(),
    block: vi.fn(),
    update: vi.fn(),
    links: new Map<string, string>(),
    hidden: [] as string[],
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "probe-atom"
      ? mocks.probe
      : atom === "server-configs"
        ? new Map([["env-a", { settings: { hiddenLinkedDeviceSources: mocks.hidden } }]])
        : mocks.can,
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Children }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string }) => (
    <div>
      {props.label}
      {props.description}
    </div>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      role="radio"
      aria-checked={props.selected}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress} />
  ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      "env-a": { environmentLabel: "Studio Mac" },
      "env-b": { environmentLabel: "Office Mac" },
    },
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.data, error: mocks.error }),
}));
vi.mock("../../state/device", () => ({
  useDeviceEnvironmentIds: () => mocks.ids,
  deviceHostProbeAtom: () => "probe-atom",
  deviceEnvironment: {
    state: () => "state-atom",
    setAccess: { permissionAtom: () => "access-permission" },
    setHold: { hold: true, permissionAtom: () => "hold-permission" },
    forget: { forget: true, permissionAtom: () => "forget-permission" },
    answerLinkRequest: { name: "answer", permissionAtom: () => "answer-permission" },
    setLinkBlocked: { name: "block", permissionAtom: () => "block-permission" },
  },
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
  serverEnvironment: {
    updateSettings: { name: "update", permissionAtom: () => "settings-permission" },
  },
}));
vi.mock("../../state/peerLinks", () => ({ useLinkedEnvironments: () => mocks.links }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: {
    hold?: boolean;
    forget?: boolean;
    name?: "answer" | "block" | "update";
  }) =>
    command.name
      ? mocks[command.name]
      : command.hold
        ? mocks.setHold
        : command.forget
          ? mocks.forget
          : mocks.setAccess,
}));
vi.mock("./WifiPairingSection", () => ({ WifiPairingSection: () => <p>Wi-Fi pairing</p> }));

import { DeviceHoldBanner } from "../devices/DeviceHoldBanner";
import { SettingsDevicesRouteScreen } from "./SettingsDevicesRouteScreen";

const device = (id: string, name: string, physical: boolean) => ({
  hostId: "local",
  id,
  name,
  platform: "android",
  version: "Android 16",
  booted: true,
  physical,
});
const state = {
  hosts: [{ id: "local", label: "This Mac" }],
  devices: [
    device("emu", "Emulator", false),
    { ...device("pixel", "Pixel", true), connection: "wifi" },
  ],
  supportsDeviceControl: true,
  access: { "local:emu": "deny", "local:gone": "ask", "local:pixel": "sometimes" },
  holds: [{ hostId: "local", deviceId: "pixel", since: "2026-01-01T00:00:00.000Z" }],
};

async function setup(next: Partial<typeof mocks> = {}, element = <SettingsDevicesRouteScreen />) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  Object.assign(
    mocks,
    {
      ids: ["env-a"],
      data: state,
      error: null,
      can: true,
      probe: { _tag: "Success" },
      links: new Map(),
      hidden: [],
    },
    next,
  );
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    press: (section: string, label: string) =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            `section[aria-label="${section}"] button[aria-label="${label}"]`,
          )!
          .click(),
      ),
    selected: (section: string) =>
      container
        .querySelector(`section[aria-label="${section}"] [aria-checked="true"]`)
        ?.getAttribute("aria-label"),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("Devices settings", () => {
  it("shows one checked policy per device, physical first, and saves, resets and hands back", async () => {
    using screen = await setup();
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toEqual(["Pixel · Physical", "Emulator"]);
    expect(screen.selected("Pixel · Physical")).toBe("Ask first");
    expect(screen.selected("Emulator")).toBe("Never");
    expect(screen.container.textContent).toContain("This Mac · Android 16 · Wi-Fi");
    expect(screen.container.textContent).toContain("Wi-Fi pairing");

    await screen.press("Pixel · Physical", "Allow");
    await screen.press("Emulator", "Reset Emulator to default");
    await screen.press("Pixel · Physical", "Hand Pixel back to the agent");
    await screen.press("Pixel · Physical", "Forget Pixel");

    const input = (extra: object) => ({
      environmentId: "env-a",
      input: { hostId: "local", ...extra },
    });
    expect(mocks.setAccess.mock.calls).toEqual([
      [input({ deviceId: "pixel", policy: "allow" })],
      [input({ deviceId: "emu", policy: null })],
    ]);
    expect(mocks.setHold.mock.calls).toEqual([[input({ deviceId: "pixel", held: false })]]);
    expect(mocks.forget.mock.calls).toEqual([[input({ deviceId: "pixel" })]]);
    expect(screen.container.querySelector('button[aria-label="Forget Emulator"]')).toBeNull();
    expect(
      screen.container.querySelector('button[aria-label="Reset Pixel to default"]'),
    ).toBeNull();
  });

  it.each([
    ["no environment has devices on", { ids: [] }, "Devices are not available"],
    ["the state is loading", { data: null }, "Finding devices..."],
    ["the state failed", { data: null, error: "Offline" }, "Could not load the devicesOffline"],
    ["no device is known", { data: { ...state, devices: [] } }, "No devices foundWi-Fi pairing"],
    [
      "discovery has not answered yet",
      { data: { ...state, devices: [] }, probe: { _tag: "Initial" } },
      "Finding devices...Wi-Fi pairing",
    ],
    [
      "the server is older",
      { data: { ...state, supportsDeviceControl: false } },
      "Update T3 Code on this environment to set device access",
    ],
  ])("says so when %s", async (_name, next, text) => {
    using screen = await setup(next);
    expect(screen.container.textContent).toContain(text);
    expect(screen.container.querySelector('[role="radio"]')).toBeNull();
  });

  it("names each environment and locks the choices without permission", async () => {
    using screen = await setup({ ids: ["env-a", "env-b"], can: false });
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toContain("Emulator · Office Mac");
    const buttons = [...screen.container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("lists linked environments' devices apart, hides one, and answers and blocks links", async () => {
    using screen = await setup({
      links: new Map([
        ["env-studio", "Studio"],
        ["env-attic", "Attic"],
      ]),
      hidden: ["env-attic"],
      data: {
        ...state,
        supportsLinkedDevices: true,
        hosts: [
          ...state.hosts,
          {
            id: "linked.env-studio",
            kind: "linked",
            label: "Studio",
            environmentId: "env-studio",
            linkState: "connected",
          },
        ],
        devices: [
          ...state.devices,
          { ...device("R5CX", "Galaxy", true), hostId: "linked.env-studio" },
        ],
        linkRequests: [
          {
            requestId: "r-1",
            linkLabel: "Laptop",
            threadTitle: "Fix login",
            hostId: "local",
            deviceId: "pixel",
            deviceName: "Pixel",
          },
        ],
        linkClients: [{ linkId: "link-1", label: "Laptop", blocked: false }],
      },
    });
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toEqual([
      "Pixel · Physical",
      "Emulator",
      "Device requests",
      "Linked environments using devices here",
      "Devices on Attic",
      "Devices on Studio",
    ]);
    const studio = screen.container.querySelector('section[aria-label="Devices on Studio"]');
    expect(studio?.textContent).toContain("Galaxy · PhysicalAndroid 16");
    expect(studio?.textContent).toContain("1 device");
    expect(
      screen.container.querySelector('section[aria-label="Devices on Attic"]')?.textContent,
    ).toContain("Hidden");

    await screen.press("Device requests", "Allow Laptop to use Pixel");
    await screen.press("Device requests", "Don't allow Laptop to use Pixel");
    await screen.press("Linked environments using devices here", "Block Laptop");
    await screen.press("Devices on Studio", "Hide devices from Studio");
    await screen.press("Devices on Attic", "Show devices from Attic");

    expect(mocks.answer.mock.calls).toEqual([
      [{ environmentId: "env-a", input: { requestId: "r-1", allow: true } }],
      [{ environmentId: "env-a", input: { requestId: "r-1", allow: false } }],
    ]);
    expect(mocks.block.mock.calls).toEqual([
      [{ environmentId: "env-a", input: { linkId: "link-1", label: "Laptop", blocked: true } }],
    ]);
    expect(mocks.update.mock.calls).toEqual([
      [
        {
          environmentId: "env-a",
          input: { patch: { hiddenLinkedDeviceSources: ["env-attic", "env-studio"] } },
        },
      ],
      [{ environmentId: "env-a", input: { patch: { hiddenLinkedDeviceSources: [] } } }],
    ]);
  });

  it("names who else holds a device in the preview banner, without a hand back", async () => {
    using screen = await setup({}, <DeviceHoldBanner heldBy="Studio" />);
    expect(screen.container.textContent).toContain("Studio is in control");
    expect(screen.container.querySelector("button")).toBeNull();
  });

  it("hands back from the preview banner", async () => {
    const onHandBack = vi.fn();
    using screen = await setup({}, <DeviceHoldBanner onHandBack={onHandBack} />);
    expect(screen.container.textContent).toContain("You are in control");
    await act(async () =>
      screen.container.querySelector<HTMLButtonElement>('button[aria-label="Hand back"]')!.click(),
    );
    expect(onHandBack).toHaveBeenCalledOnce();
  });
});
