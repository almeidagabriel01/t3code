import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    ids: ["hub"] as string[],
    settings: null as unknown,
    loadError: null as string | null,
    can: true,
    configure: vi.fn(),
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
    secureTextEntry?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      type={props.secureTextEntry ? "password" : "text"}
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
  EmptyState: (props: { title: string; detail?: string }) => (
    <p>
      {props.title} {props.detail}
    </p>
  ),
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
  ListSection: (props: { title?: string; footer?: string; children?: ReactNode }) => (
    <section>
      <h3>{props.title}</h3>
      {props.children}
      <small>{props.footer}</small>
    </section>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsActionRow", () => ({
  SettingsActionRow: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
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
      hub: { environmentLabel: "Studio" },
      other: { environmentLabel: "Office" },
    },
  }),
}));
vi.mock("../../state/telegramChannel", () => ({
  useTelegramEnvironmentIds: () => mocks.ids,
  useTelegramChannel: () => ({
    settings: mocks.settings,
    loadError: mocks.loadError,
    canConfigure: mocks.can,
    configure: mocks.configure,
  }),
}));

import { SettingsTelegramRouteScreen } from "./SettingsTelegramRouteScreen";

const base = {
  enabled: false,
  tokenConfigured: false,
  allowedUserIds: [] as string[],
  status: "disabled",
};
let root: Root;
let container: HTMLDivElement;
const render = (settings: Record<string, unknown> = {}) => {
  mocks.settings = { ...base, ...settings };
  act(() => root.render(<SettingsTelegramRouteScreen />));
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
  mocks.loadError = null;
  mocks.can = true;
  mocks.configure.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => act(() => root.unmount()));

describe("Telegram settings", () => {
  it("shows the status, the bot's name and a failed reply", () => {
    render({ status: "running", botUsername: "my_bot" });
    expect(container.textContent).toContain("Connected as @my_bot");
    render({
      status: "error",
      lastError: "invalid_token",
      lastDeliveryError: { code: "chat_not_found", at: "2026-10-01T00:00:00.000Z" },
    });
    expect(container.textContent).toContain("Telegram does not accept this bot token");
    expect(container.textContent).toContain("send the bot a message first");
  });

  it("explains how to make a bot", () => {
    render();
    expect(container.textContent).toContain("@BotFather and send /newbot");
    expect(container.textContent).toContain("4. Allow yourself");
  });

  it("needs only a token before the switch can be turned on, then sends {enabled:true}", async () => {
    render();
    expect(input("Use Telegram")!.disabled).toBe(true);
    expect(container.textContent).toContain("Add the bot token before turning this on.");
    render({ tokenConfigured: true });
    expect(input("Use Telegram")!.disabled).toBe(false);
    await act(async () => input("Use Telegram")!.click());
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: true });
  });

  it("lists people waiting for approval, and allows or ignores them", async () => {
    render({ allowedUserIds: ["111"] });
    const titles = () => [...container.querySelectorAll("h3")].map((title) => title.textContent);
    expect(titles()).not.toContain("Waiting for approval");
    render({
      allowedUserIds: ["111"],
      pendingSenders: [
        {
          userId: "222",
          firstName: "Bo",
          username: "bo_x",
          lastSeenAt: "2026-10-01T00:00:00.000Z",
        },
        { userId: "333", lastSeenAt: "2026-10-01T00:00:00.000Z" },
      ],
    });
    expect(titles()).toContain("Waiting for approval");
    expect(container.textContent).toContain("@bo_x");
    await press("Allow Bo");
    expect(mocks.configure).toHaveBeenLastCalledWith({ allowedUserIds: ["111", "222"] });
    await press("Ignore 333");
    expect(mocks.configure).toHaveBeenLastCalledWith({ dismissUserIds: ["333"] });
    mocks.can = false;
    render({
      pendingSenders: [{ userId: "222", firstName: "Bo", lastSeenAt: "2026-10-01T00:00:00.000Z" }],
    });
    expect(button("Allow Bo")!.disabled).toBe(true);
    expect(button("Ignore Bo")!.disabled).toBe(true);
  });

  it("lets an enabled channel be turned off", async () => {
    render({ enabled: true, status: "running" });
    expect(input("Use Telegram")!.disabled).toBe(false);
    await act(async () => input("Use Telegram")!.click());
    expect(mocks.configure).toHaveBeenCalledWith({ enabled: false });
  });

  it("saves, replaces and removes the token without showing it", async () => {
    render();
    expect(input("Bot token")!.type).toBe("password");
    expect(button("Save token")!.disabled).toBe(true);
    type("Bot token", " 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ ");
    await press("Save token");
    expect(mocks.configure).toHaveBeenLastCalledWith({
      botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });
    expect(input("Bot token")!.value).toBe("");
    expect(button("Remove token")).toBeNull();

    render({ tokenConfigured: true });
    expect(container.textContent).toContain("Token saved");
    type("Bot token", "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA");
    await press("Replace token");
    expect(mocks.configure).toHaveBeenLastCalledWith({
      botToken: "654321:ZYXWVUTSRQPONMLKJIHGFEDCBA",
    });
    await press("Remove token");
    expect(mocks.configure).toHaveBeenLastCalledWith({ clearToken: true });
  });

  it("adds and removes user ids, sending the full list", async () => {
    render({ allowedUserIds: ["111"] });
    type("Telegram user id", "2a2b2");
    expect(input("Telegram user id")!.value).toBe("222");
    await press("Add user id");
    expect(mocks.configure).toHaveBeenLastCalledWith({ allowedUserIds: ["111", "222"] });
    expect(input("Telegram user id")!.value).toBe("");
    await press("Remove 111");
    expect(mocks.configure).toHaveBeenLastCalledWith({ allowedUserIds: [] });
  });

  it("rejects a repeated id locally and shows the server's refusal", async () => {
    render({ allowedUserIds: ["111"] });
    type("Telegram user id", "111");
    await press("Add user id");
    expect(container.textContent).toContain("already added");
    expect(mocks.configure).not.toHaveBeenCalled();
    mocks.configure.mockResolvedValueOnce({ ok: false, message: "nope: not an id" });
    type("Telegram user id", "999");
    await press("Add user id");
    expect(container.textContent).toContain("nope: not an id");
    expect(input("Telegram user id")!.value).toBe("999");
  });

  it("disables every change without permission", () => {
    mocks.can = false;
    render({ tokenConfigured: true, allowedUserIds: ["111"] });
    expect(input("Use Telegram")!.disabled).toBe(true);
    expect(input("Bot token")!.disabled).toBe(true);
    expect(button("Remove token")!.disabled).toBe(true);
    expect(input("Telegram user id")!.disabled).toBe(true);
    expect(button("Remove 111")!.disabled).toBe(true);
    expect(button("Language hub")!.disabled).toBe(true);
  });

  it("shows the language choice, editable with permission", () => {
    render();
    expect(button("Language hub")!.disabled).toBe(false);
  });

  it("names the environment only when there are several", () => {
    render();
    expect(container.textContent).not.toContain("Studio");
    mocks.ids = ["hub", "other"];
    render();
    expect(container.textContent).toContain("Connection · Studio");
    expect(container.textContent).toContain("Connection · Office");
  });

  it("shows loading, a load failure, and the unavailable state", () => {
    mocks.ids = ["hub"];
    mocks.settings = null;
    act(() => root.render(<SettingsTelegramRouteScreen />));
    expect(container.textContent).toContain("Loading Telegram");
    mocks.loadError = "offline";
    act(() => root.render(<SettingsTelegramRouteScreen />));
    expect(container.textContent).toContain("Could not load Telegram offline");
    mocks.ids = [];
    render();
    expect(container.textContent).toContain("Telegram is not available");
  });
});
