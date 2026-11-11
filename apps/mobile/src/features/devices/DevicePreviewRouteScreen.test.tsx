import { EnvironmentId, ThreadId, type DeviceUserInput } from "@t3tools/contracts";
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadDevicePreview } from "./threadDevicePreviews";

type WebViewProps = {
  readonly source: { readonly html: string };
  readonly onMessage: (event: { nativeEvent: { data: string } }) => void;
};

const { mocks, Children } = vi.hoisted(() => {
  const chain: Record<string, unknown> = {};
  for (const name of ["duration", "delay", "reduceMotion"]) chain[name] = () => chain;
  return {
    Children: ({ children }: { children?: ReactNode }) => children,
    mocks: {
      chain,
      previews: [] as unknown[],
      phone: { send: vi.fn(), pending: false, error: null as string | null },
      webView: null as WebViewProps | null,
      inject: vi.fn(),
    },
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StatusBar: () => null,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: { accessibilityLabel: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("react-native-webview", () => ({
  WebView: ({ ref, ...props }: WebViewProps & { ref: Ref<unknown> }) => {
    mocks.webView = props;
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.inject }));
    return null;
  },
}));
vi.mock("@t3tools/mobile-device-stream", () => ({ default: "" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
  FadeIn: mocks.chain,
  FadeOut: mocks.chain,
  ReduceMotion: { System: "system" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-sensors", () => ({
  Accelerometer: { setUpdateInterval: vi.fn(), addListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: Children }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/useBarInset", () => ({ useBarOverlap: () => 0 }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetCloseButton: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; onPress: () => void }) => (
    <button aria-label={props.label} onClick={props.onPress} />
  ),
}));
vi.mock("../../components/ui/ControlPill", () => ({
  ControlPill: (props: {
    accessibilityLabel: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          role="menuitem"
          aria-label={action.title}
          disabled={action.attributes?.disabled}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        />
      ))}
    </div>
  ),
}));
vi.mock("../../lib/appState", () => ({ useAppForeground: () => true }));
vi.mock("../../lib/backHandler", () => ({ useHardwareBack: () => undefined }));
vi.mock("../../lib/reserved-regions", () => ({
  deriveBottomControlInsets: () => ({ left: 0, right: 0 }),
}));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => ({}) }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "viewer" }));
vi.mock("../../state/device", () => ({
  deviceEnvironment: {
    list: "list",
    shutdown: "shutdown",
    setHold: { permissionAtom: () => "hold-permission" },
    state: () => "state-atom",
  },
  useDeviceHubAccess: () => ({
    access: { httpBase: "http://studio.local:3773" },
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { hosts: [], hostStatuses: {} }, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("./usePhoneInput", () => ({ usePhoneInput: () => mocks.phone }));
vi.mock("./threadDevicePreviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./threadDevicePreviews")>()),
  threadDevicePreviews: () => mocks.previews,
}));

import { DevicePreviewScreen } from "./DevicePreviewRouteScreen";

const device = (fields: Partial<ThreadDevicePreview>) =>
  ({
    key: "usb-iphone",
    session: { hostId: "local", deviceId: "iphone-1", platform: "ios" },
    name: "Gabriel's iPhone",
    description: "Physical",
    physical: true,
    capture: true,
    phoneControl: true,
    viewOnlyNotice: null,
    issues: [],
    blocked: null,
    canHold: false,
    held: false,
    heldBy: null,
    heldThere: false,
    serveSimOnly: false,
    ...fields,
  }) as ThreadDevicePreview;

async function setup(
  preview: ThreadDevicePreview,
  options: {
    readonly phone?: { pending: boolean; error: string | null };
    readonly embedded?: boolean;
  } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.previews = [preview];
  mocks.phone = { send: vi.fn(), pending: false, error: null, ...options.phone };
  mocks.webView = null;
  mocks.inject = vi.fn();
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <DevicePreviewScreen
        environmentId={EnvironmentId.make("env-a")}
        threadId={ThreadId.make("thread-a")}
        onClose={vi.fn()}
        {...(options.embedded ? { onMaximize: vi.fn() } : {})}
      />,
    ),
  );
  return {
    container,
    button: (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    post: (message: object) =>
      act(async () => mocks.webView!.onMessage({ nativeEvent: { data: JSON.stringify(message) } })),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

const tap: DeviceUserInput = { type: "tap", x: 0.5, y: 0.25 };

describe("device viewer driving a USB iPhone", () => {
  it("sends the viewer's gestures to the phone, with Home and App switcher live before input connects", async () => {
    using screen = await setup(device({}));
    expect(mocks.webView!.source.html).toContain('"phoneControl":true');
    await screen.post({ type: "phoneInput", input: tap });
    expect(mocks.phone.send).toHaveBeenCalledWith(tap);
    expect(screen.button("Home")!.disabled).toBe(false);
    expect(screen.button("App switcher")!.disabled).toBe(false);
    await act(async () => screen.button("Home")!.click());
    expect(mocks.inject).toHaveBeenCalledWith('window.T3DeviceStream?.command("home"); true;');
  });

  it("shows a sending pill while the phone works and the error once it fails", async () => {
    {
      using screen = await setup(device({}), { phone: { pending: true, error: null } });
      expect(screen.container.textContent).toContain("Sending to the phone…");
    }
    {
      using screen = await setup(device({}), {
        phone: { pending: false, error: "The phone is locked." },
      });
      expect(screen.container.textContent).toContain("The phone is locked.");
      expect(screen.container.textContent).not.toContain("Sending to the phone…");
    }
    using screen = await setup(device({}));
    expect(screen.container.textContent).not.toContain("Sending to the phone…");
  });

  it("keeps a view-only iPhone view only: no phone input, no Home, no App switcher", async () => {
    using screen = await setup(device({ phoneControl: false }));
    expect(mocks.webView!.source.html).not.toContain('"phoneControl"');
    await screen.post({ type: "phoneInput", input: tap });
    expect(mocks.phone.send).not.toHaveBeenCalled();
    expect(screen.button("Home")).toBeNull();
    expect(screen.button("App switcher")).toBeNull();
  });

  it("locks a simulator's controls until its input connects, in the pane and full screen", async () => {
    for (const embedded of [false, true]) {
      using screen = await setup(
        device({
          key: "sim",
          session: { hostId: "local", deviceId: "sim-1", platform: "ios" } as never,
          physical: false,
          capture: false,
          phoneControl: false,
        }),
        { embedded },
      );
      expect(screen.button("Home")!.disabled).toBe(true);
      expect(screen.button("Rotate device")!.disabled).toBe(true);
      await screen.post({ type: "phoneInput", input: tap });
      expect(mocks.phone.send).not.toHaveBeenCalled();
      await screen.post({ type: "input", connected: true });
      expect(screen.button("Home")!.disabled).toBe(false);
      expect(screen.button("App switcher")!.disabled).toBe(false);
      expect(screen.button("Rotate device")!.disabled).toBe(false);
    }
  });
});
