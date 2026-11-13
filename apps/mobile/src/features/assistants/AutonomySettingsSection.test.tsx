import { DEFAULT_AUTONOMY_SETTINGS, type AutonomySettings } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    autonomy: null as unknown as AutonomySettings,
    write: vi.fn(),
    navigate: vi.fn(),
    telegramIds: [] as string[],
    telegram: null as null | { enabled: boolean; tokenConfigured: boolean },
  },
}));
vi.mock("react-native", () => ({
  View: Children,
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (value: string) => void;
    onEndEditing: () => void;
    editable?: boolean;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      readOnly={props.editable === false}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
      onBlur={props.onEndEditing}
    />
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/ListSection", () => ({ ListSection: Children }));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { label: string; accessory?: ReactNode }) => (
    <>
      {props.label}
      {props.accessory}
    </>
  ),
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../components/ui/ListToggleRow", () => ({
  ListToggleRow: (props: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={props.label}
      data-disabled={props.disabled ? "" : undefined}
      checked={props.value}
      onChange={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../state/autonomy", () => ({
  useAutonomySettings: () => ({ autonomy: mocks.autonomy, write: mocks.write }),
}));
vi.mock("../../state/telegramChannel", () => ({
  useTelegramEnvironmentIds: () => mocks.telegramIds,
  useTelegramChannel: () => ({ settings: mocks.telegram }),
}));

import { AutonomySettingsSection } from "./AutonomySettingsSection";

let root: Root;
let container: HTMLDivElement;
const render = (suffix = "") =>
  act(() =>
    root.render(<AutonomySettingsSection environmentId={"hub" as never} suffix={suffix} />),
  );
const input = (label: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const toggle = (label: string) => act(() => input(label).click());
const type = (label: string, value: string, commit = true) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input(label),
      value,
    );
    input(label).dispatchEvent(new Event("input", { bubbles: true }));
    if (commit) input(label).dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = window.document.createElement("div");
  root = createRoot(container);
  mocks.autonomy = DEFAULT_AUTONOMY_SETTINGS;
  mocks.write.mockReset();
  mocks.navigate.mockReset();
  mocks.telegramIds = [];
  mocks.telegram = null;
});
afterEach(() => act(() => root.unmount()));

describe("autonomy settings", () => {
  it("writes the whole object for every switch", () => {
    render();
    toggle("Assistants can notify you");
    expect(mocks.write).toHaveBeenLastCalledWith({ ...DEFAULT_AUTONOMY_SETTINGS, enabled: true });
  });

  it.each([
    [false, true],
    [true, false],
  ])("locks rules, limits and channels while paused (enabled: %s)", (enabled, locked) => {
    mocks.autonomy = { ...DEFAULT_AUTONOMY_SETTINGS, enabled };
    render();
    expect(input("Assistants can notify you").hasAttribute("data-disabled")).toBe(false);
    for (const label of ["Run looks stuck", "Notify on Telegram"]) {
      expect(input(label).hasAttribute("data-disabled")).toBe(locked);
    }
    expect(input("Waiting for you after").readOnly).toBe(locked);
  });

  it.each([
    ["Run failed or was interrupted", "runFailed"],
    ["Waiting for you too long", "waitingTooLong"],
    ["Run looks stuck", "stuck"],
    ["PR checks failed", "ciFailed"],
  ] as const)("toggles the %s rule", (label, rule) => {
    render();
    toggle(label);
    expect(mocks.write).toHaveBeenLastCalledWith({
      ...DEFAULT_AUTONOMY_SETTINGS,
      rules: { ...DEFAULT_AUTONOMY_SETTINGS.rules, [rule]: !DEFAULT_AUTONOMY_SETTINGS.rules[rule] },
    });
  });

  it("toggles the waiting notice and locks its delay while it is off", () => {
    render();
    toggle("Notify me when something is waiting for me");
    expect(mocks.write).toHaveBeenLastCalledWith({
      ...DEFAULT_AUTONOMY_SETTINGS,
      notifyWaiting: false,
    });
    mocks.autonomy = { ...DEFAULT_AUTONOMY_SETTINGS, enabled: true, notifyWaiting: false };
    render();
    expect(input("Notify after").readOnly).toBe(true);
    expect(input("Messages from assistants per day").readOnly).toBe(false);
  });

  it("toggles a channel", () => {
    render();
    toggle("Notify on T3 Activity");
    const channels = DEFAULT_AUTONOMY_SETTINGS.channels.includes("t3")
      ? DEFAULT_AUTONOMY_SETTINGS.channels.filter((channel) => channel !== "t3")
      : [...DEFAULT_AUTONOMY_SETTINGS.channels, "t3"];
    expect(mocks.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ channels: expect.arrayContaining(channels) }),
    );
  });

  it.each([
    ["Waiting for you after", "waitingMinutes", "45"],
    ["Stuck after", "stuckMinutes", "90"],
    ["Notifications per day", "maxWakesPerDay", "7"],
    ["Notify after", "notifyWaitingAfterMinutes", "0"],
    ["Messages from assistants per day", "maxUserMessagesPerDay", "50"],
  ] as const)("commits %s once it is a valid whole number", (label, key, value) => {
    render();
    type(label, value);
    expect(mocks.write).toHaveBeenCalledWith({
      ...DEFAULT_AUTONOMY_SETTINGS,
      [key]: Number(value),
    });
  });

  it("refuses an out-of-range number, says why and puts the saved value back", () => {
    render();
    type("Stuck after", "0", false);
    expect(container.textContent).toContain("Enter a whole number from 1 to 1440.");
    act(() => input("Stuck after").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(input("Stuck after").value).toBe(String(DEFAULT_AUTONOMY_SETTINGS.stuckMinutes));
  });

  it("does not write an unchanged number", () => {
    render();
    type("Stuck after", String(DEFAULT_AUTONOMY_SETTINGS.stuckMinutes));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  describe("with Telegram on", () => {
    beforeEach(() => {
      mocks.autonomy = { ...DEFAULT_AUTONOMY_SETTINGS, channels: ["telegram"] };
    });

    it("says so when the server cannot do Telegram", () => {
      render(" · Hub");
      expect(container.textContent).toContain("Telegram is not available");
    });

    it("stays quiet when the bot is connected", () => {
      mocks.telegramIds = ["hub"];
      mocks.telegram = { enabled: true, tokenConfigured: true };
      render();
      expect(container.textContent).not.toContain("Telegram is not");
    });

    it("links to Telegram settings when no bot is connected", () => {
      mocks.telegramIds = ["hub"];
      mocks.telegram = { enabled: false, tokenConfigured: false };
      render();
      act(() =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Telegram is not set up")!
          .click(),
      );
      expect(mocks.navigate).toHaveBeenCalledWith("SettingsTelegram");
    });
  });
});
