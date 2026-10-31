import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["hub"] as string[],
    settings: null as unknown,
    identities: [] as unknown[],
    can: true,
    configure: vi.fn(),
    disconnect: vi.fn(),
    createLinkCode: vi.fn(),
    unlink: vi.fn(),
    confirm: vi.fn(),
    copy: vi.fn(),
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
vi.mock("expo-clipboard", () => ({ setStringAsync: (text: string) => mocks.copy(text) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: mocks.confirm }));
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
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
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
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../../state/slackChannel", () => ({
  useSlackEnvironmentIds: () => mocks.ids,
  useSlackChannel: () => ({
    settings: mocks.settings,
    loadError: null,
    identities: mocks.identities,
    canConfigure: mocks.can,
    canDisconnect: mocks.can,
    canLink: mocks.can,
    canUnlink: mocks.can,
    configure: mocks.configure,
    disconnect: mocks.disconnect,
    createLinkCode: mocks.createLinkCode,
    unlink: mocks.unlink,
  }),
}));

import { SettingsSlackRouteScreen } from "./SettingsSlackRouteScreen";

const base = {
  connectionId: "slack-1",
  enabled: false,
  hasAppToken: true,
  hasBotToken: true,
  allowedChannelIds: [] as string[],
  status: "disabled",
};
let root: Root;
let container: HTMLDivElement;
const render = (settings: Record<string, unknown> = {}) => {
  mocks.settings = { ...base, ...settings };
  act(() => root.render(<SettingsSlackRouteScreen />));
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
  mocks.identities = [];
  mocks.can = true;
  mocks.configure.mockReset().mockResolvedValue({ ok: true, value: undefined });
  mocks.disconnect.mockReset().mockResolvedValue({ ok: true, value: undefined });
  mocks.createLinkCode.mockReset();
  mocks.unlink.mockReset().mockResolvedValue({ ok: true, value: undefined });
  mocks.confirm.mockReset();
  mocks.copy.mockReset().mockResolvedValue(undefined);
});
afterEach(() => act(() => root.unmount()));

describe("Slack settings", () => {
  it.each([
    [{ status: "disabled" }, "Off"],
    [{ status: "connecting" }, "Connecting…"],
    [{ status: "reconnecting" }, "Reconnecting…"],
    [{ status: "connected", teamId: "T123" }, "Connected to T123"],
    [{ status: "error", lastError: "token_revoked" }, "Slack revoked a token"],
    [{ status: "error", lastError: "app_uninstalled" }, "uninstalled"],
    [{ status: "error", lastError: "invalid_token" }, "Slack rejected a token"],
    [{ status: "error", lastError: "workspace_mismatch" }, "different Slack workspaces"],
    [{ status: "error", lastError: "missing_token" }, "Both tokens are needed"],
    [{ status: "error" }, "Slack could not connect"],
    [
      { status: "connected", lastDeliveryError: { code: "not_in_channel", at: "2026-01-01" } },
      "not in the channel",
    ],
  ])("shows %j as a readable status", (settings, text) => {
    render(settings);
    expect(container.textContent).toContain(text);
  });

  it("keeps Use Slack off until both tokens are saved, then enables with {enabled:true}", async () => {
    render({ hasBotToken: false });
    expect(input("Use Slack")!.disabled).toBe(true);
    expect(container.textContent).toContain("Save both tokens first.");
    render();
    expect(input("Use Slack")!.disabled).toBe(false);
    await act(async () => input("Use Slack")!.click());
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: true });
  });

  it("saves only the token that was typed and clears the fields", async () => {
    render({ hasAppToken: false, hasBotToken: false });
    expect(button("Save tokens")!.disabled).toBe(true);
    type("Bot token", " xoxb-1 ");
    await press("Save tokens");
    expect(mocks.configure).toHaveBeenCalledWith({ botToken: "xoxb-1" });
    expect(input("Bot token")!.value).toBe("");
  });

  it("shows saved tokens write-only and offers a replace flow", async () => {
    render();
    expect(input("App token")).toBeNull();
    expect(container.textContent).toContain("Saved");
    await press("Replace tokens");
    type("App token", "xapp-2");
    await press("Save tokens");
    expect(mocks.configure).toHaveBeenCalledWith({ appToken: "xapp-2" });
    expect(input("App token")).toBeNull();
  });

  it("says Slack rejected the token, and other failures by their message", async () => {
    render({ hasAppToken: false });
    mocks.configure.mockResolvedValueOnce({ ok: false, message: "x", invalidToken: true });
    type("App token", "bad");
    await press("Save tokens");
    expect(container.textContent).toContain("Slack rejected this token.");
    mocks.configure.mockResolvedValueOnce({
      ok: false,
      message: "Could not save",
      invalidToken: false,
    });
    await press("Save tokens");
    expect(container.textContent).toContain("Could not save");
  });

  it("confirms before removing tokens, then disconnects", async () => {
    render();
    await press("Remove tokens");
    expect(mocks.disconnect).not.toHaveBeenCalled();
    const request = mocks.confirm.mock.calls[0]![0];
    expect(request.destructive).toBe(true);
    await act(async () => request.onConfirm());
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it("validates, adds and removes channels", async () => {
    render({ allowedChannelIds: ["C00000000"] });
    type("Channel ID", "nope");
    await press("Add channel");
    expect(container.textContent).toContain("A channel ID starts with C or G");
    type("Channel ID", "c00000000");
    await press("Add channel");
    expect(container.textContent).toContain("already added");
    type("Channel ID", "g11111111");
    await press("Add channel");
    expect(mocks.configure).toHaveBeenCalledWith({ allowedChannelIds: ["C00000000", "G11111111"] });
    expect(input("Channel ID")!.value).toBe("");
    await press("Remove C00000000");
    expect(mocks.configure).toHaveBeenLastCalledWith({ allowedChannelIds: [] });
  });

  it("creates a link code with its instruction and copies it", async () => {
    render();
    expect(container.textContent).toContain("No linked accounts");
    mocks.createLinkCode.mockResolvedValue({
      ok: true,
      value: { code: "ABC123", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    await press("Link your Slack account");
    expect(mocks.createLinkCode).toHaveBeenCalledWith("slack-1");
    expect(container.textContent).toContain("ABC123");
    expect(container.textContent).toContain("Expires");
    expect(container.textContent).toContain("Send `link ABC123` to the bot in a direct message.");
    await press("Copy link command");
    expect(mocks.copy).toHaveBeenCalledWith("link ABC123");
  });

  it("lists linked accounts and unlinks one", async () => {
    mocks.identities = [
      { externalActorId: "U111", linkedAt: "2026-01-01T00:00:00.000Z" },
      { externalActorId: "U222", displayName: "Ana", linkedAt: "not a date" },
    ];
    render();
    expect(container.textContent).toContain("Slack user U111");
    expect(container.textContent).toContain("Ana");
    await press("Unlink U111");
    expect(mocks.unlink).toHaveBeenCalledWith("slack-1", "U111");
  });

  it("copies the manifest", async () => {
    render();
    await press("Copy manifest");
    expect(mocks.copy.mock.calls[0]![0]).toContain("socket_mode_enabled: true");
    expect(container.textContent).toContain("Copied");
  });

  it("disables every change without permission", () => {
    mocks.can = false;
    render({ allowedChannelIds: ["C00000000"] });
    for (const label of [
      "Remove tokens",
      "Replace tokens",
      "Link your Slack account",
      "Remove C00000000",
    ]) {
      expect(button(label)!.disabled).toBe(true);
    }
    expect(input("Use Slack")!.disabled).toBe(true);
    expect(input("Channel ID")!.disabled).toBe(true);
  });

  it("explains when no environment supports Slack", () => {
    mocks.ids = [];
    render();
    expect(container.textContent).toContain("Slack is not available");
  });
});
