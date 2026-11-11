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
  },
}));
vi.mock("react-native", () => ({ View: Children }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "probe-atom" ? mocks.probe : mocks.can),
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
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    title: string;
    actions: { id: string; title: string; state?: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div role="group" aria-label={props.title}>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          role="menuitemradio"
          aria-checked={action.state === "on"}
          aria-label={action.title}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </div>
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
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { hold?: boolean; forget?: boolean }) =>
    command.hold ? mocks.setHold : command.forget ? mocks.forget : mocks.setAccess,
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
    { ids: ["env-a"], data: state, error: null, can: true, probe: { _tag: "Success" } },
    next,
  );
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  const menu = (name: string) => `[role="group"][aria-label="Agents and ${name}"]`;
  const click = (selector: string) =>
    act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  return {
    container,
    choose: (name: string, label: string) => click(`${menu(name)} button[aria-label="${label}"]`),
    press: (label: string) => click(`button[aria-label="${label}"]`),
    selected: (name: string) =>
      container.querySelector(`${menu(name)} [aria-checked="true"]`)?.getAttribute("aria-label"),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("Devices settings", () => {
  it("lists each device in one row, physical first, and saves, resets and hands back", async () => {
    using screen = await setup();
    const rows = [...screen.container.querySelectorAll('[role="group"]')].map((row) =>
      row.getAttribute("aria-label"),
    );
    expect(rows).toEqual(["Agents and Pixel", "Agents and Emulator"]);
    expect(screen.selected("Pixel")).toBe("Ask first");
    expect(screen.selected("Emulator")).toBe("Never");
    expect(screen.container.textContent).toContain(
      "PixelThis Mac · Android 16 · Physical · Wi-Fi · In your control",
    );
    expect(screen.container.textContent).toContain("EmulatorThis Mac · Android 16");
    expect(screen.container.textContent).toContain("Wi-Fi pairing");

    await screen.choose("Pixel", "Allow");
    await screen.choose("Emulator", "Reset to default");
    await screen.press("Hand Pixel back to the agent");
    await screen.press("Forget Pixel");

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
      screen.container.querySelector('button[aria-label="Hand Emulator back to the agent"]'),
    ).toBeNull();
    expect(
      screen.container.querySelector(
        `[aria-label="Agents and Pixel"] [aria-label="Reset to default"]`,
      ),
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
    expect(screen.container.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it("names each environment and locks the choices without permission", async () => {
    using screen = await setup({ ids: ["env-a", "env-b"], can: false });
    const titles = [...screen.container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles).toEqual(["Device access · Studio Mac", "Device access · Office Mac"]);
    const buttons = [...screen.container.querySelectorAll("button")];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
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
