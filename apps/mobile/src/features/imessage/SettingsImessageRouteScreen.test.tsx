import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["hub"] as string[],
    settings: null as unknown,
    access: "ok" as string | null,
    ownHandles: [] as string[],
    can: true,
    configure: vi.fn(),
    checkAccess: vi.fn(),
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  Pressable: (props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
    children?: ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.children}
    </button>
  ),
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      disabled={props.editable === false}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; description?: string; accessory?: ReactNode }) => (
    <div>
      <span>{props.label}</span>
      <span>{props.description}</span>
      {props.accessory}
    </div>
  ),
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { title?: string; children?: ReactNode }) => (
    <section>
      <h3>{props.title}</h3>
      {props.children}
    </section>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsActionRow", () => ({
  SettingsActionRow: (props: {
    label: string;
    description?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
      {props.description}
    </button>
  ),
}));
vi.mock("../settings/components/ChannelLanguageSection", () => ({
  ChannelLanguageSection: (props: { environmentId: string; disabled: boolean }) => (
    <button aria-label={`Language ${props.environmentId}`} disabled={props.disabled} />
  ),
}));
vi.mock("../settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    subtitle?: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <label>
      {props.subtitle}
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.value}
        disabled={props.disabled}
        onChange={() => props.onValueChange(!props.value)}
      />
    </label>
  ),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: {
      hub: { environmentLabel: "Studio Mac" },
      other: { environmentLabel: "Office Mac" },
    },
  }),
}));
vi.mock("../../state/imessageChannel", () => ({
  useImessageEnvironmentIds: () => mocks.ids,
  useImessageChannel: () => ({
    settings: mocks.settings,
    loadError: null,
    access: mocks.access,
    ownHandles: mocks.ownHandles,
    checkAccess: mocks.checkAccess,
    canConfigure: mocks.can,
    configure: mocks.configure,
  }),
}));

import { SettingsImessageRouteScreen } from "./SettingsImessageRouteScreen";

const base = {
  enabled: false,
  allowedHandles: [] as string[],
  selfHandles: ["+5511999999999"] as string[],
  status: "disabled",
};
let root: Root;
let container: HTMLDivElement;
const render = (settings: Record<string, unknown> = {}) => {
  mocks.settings = { ...base, ...settings };
  act(() => root.render(<SettingsImessageRouteScreen />));
};
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const input = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const press = async (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`Missing button: ${label}`);
  await act(async () => found.click());
};
const type = (label: string, value: string) =>
  act(() => {
    const field = input(label)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.ids = ["hub"];
  mocks.access = "ok";
  mocks.ownHandles = [];
  mocks.can = true;
  mocks.configure.mockReset().mockResolvedValue({ ok: true });
  mocks.checkAccess.mockReset();
});
afterEach(() => act(() => root.unmount()));

describe("iMessage settings", () => {
  it("shows access states and checks again", async () => {
    render();
    expect(container.textContent).toContain("Full Disk Access: Granted");
    mocks.access = "full_disk_access_missing";
    render();
    expect(container.textContent).toContain("Not granted");
    expect(container.textContent).toContain("Full Disk Access and turn on T3 Code");
    await press("Check again");
    expect(mocks.checkAccess).toHaveBeenCalledOnce();
    mocks.access = "messages_not_signed_in";
    render();
    expect(container.textContent).toContain("Messages is not signed in");
  });

  it("shows status errors as sentences", () => {
    render({ status: "error", lastError: "automation_denied" });
    expect(container.textContent).toContain("not allowed to control Messages");
  });

  it("keeps Use iMessage off until access and a handle exist, then sends {enabled:true}", async () => {
    mocks.access = "full_disk_access_missing";
    render();
    expect(input("Use iMessage")!.disabled).toBe(true);
    expect(container.textContent).toContain("Grant access first.");
    mocks.access = "ok";
    render({ selfHandles: [] });
    expect(input("Use iMessage")!.disabled).toBe(true);
    expect(container.textContent).toContain("Add at least one number or email first.");
    render();
    expect(input("Use iMessage")!.disabled).toBe(false);
    await act(async () => input("Use iMessage")!.click());
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: true });
  });

  it("lets an enabled channel be turned off even when access broke", async () => {
    mocks.access = "full_disk_access_missing";
    render({ enabled: true, status: "error" });
    expect(input("Use iMessage")!.disabled).toBe(false);
    await act(async () => input("Use iMessage")!.click());
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: false });
  });

  it("adds and removes handles in both lists, sending the full list", async () => {
    render({ allowedHandles: ["a@b.com"] });
    type("Your number or email", " me@x.com ");
    await press("Add yours");
    expect(mocks.configure).toHaveBeenLastCalledWith({
      selfHandles: ["+5511999999999", "me@x.com"],
    });
    expect(input("Your number or email")!.value).toBe("");
    type("Allowed number or email", "+15550001111");
    await press("Add account");
    expect(mocks.configure).toHaveBeenLastCalledWith({
      allowedHandles: ["a@b.com", "+15550001111"],
    });
    await press("Remove a@b.com");
    expect(mocks.configure).toHaveBeenLastCalledWith({ allowedHandles: [] });
    await press("Remove +5511999999999");
    expect(mocks.configure).toHaveBeenLastCalledWith({ selfHandles: [] });
  });

  it("adds the Mac's own handles that neither list has in one tap", async () => {
    mocks.ownHandles = ["me@x.com", "+5511999999999", "a@b.com"];
    render({ allowedHandles: ["a@b.com"] });
    expect(container.textContent).toContain("me@x.com");
    await press("Add the ones found on this Mac");
    expect(mocks.configure).toHaveBeenLastCalledWith({
      selfHandles: ["+5511999999999", "me@x.com"],
    });
    mocks.ownHandles = ["+5511999999999"];
    render();
    expect(button("Add the ones found on this Mac")).toBeNull();
  });

  it("rejects duplicates locally and shows the server's validation error", async () => {
    render();
    type("Your number or email", "+5511999999999");
    await press("Add yours");
    expect(container.textContent).toContain("already added");
    expect(mocks.configure).not.toHaveBeenCalled();
    mocks.configure.mockResolvedValueOnce({ ok: false, message: "nope: not a phone number" });
    type("Your number or email", "bad");
    await press("Add yours");
    expect(container.textContent).toContain("nope: not a phone number");
    expect(input("Your number or email")!.value).toBe("bad");
  });

  it("disables every change without permission", () => {
    mocks.can = false;
    render({ allowedHandles: ["a@b.com"] });
    expect(input("Use iMessage")!.disabled).toBe(true);
    expect(button("Add yours")!.disabled).toBe(true);
    expect(button("Add account")!.disabled).toBe(true);
    expect(button("Remove a@b.com")!.disabled).toBe(true);
    expect(input("Allowed number or email")!.disabled).toBe(true);
    expect(button("Language hub")!.disabled).toBe(true);
  });

  it("shows the language choice once per environment, editable with permission", () => {
    render();
    expect(button("Language hub")!.disabled).toBe(false);
  });

  it("names the environment only when there are several", () => {
    render();
    expect(container.textContent).not.toContain("Studio Mac");
    mocks.ids = ["hub", "other"];
    render();
    expect(container.textContent).toContain("Access · Studio Mac");
    expect(container.textContent).toContain("Access · Office Mac");
  });

  it("explains when no environment supports iMessage", () => {
    mocks.ids = [];
    render();
    expect(container.textContent).toContain("iMessage is not available");
  });
});
