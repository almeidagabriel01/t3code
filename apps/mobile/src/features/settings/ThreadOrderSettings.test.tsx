import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    preferences: null as unknown,
    save: vi.fn(),
  },
}));

vi.mock("react-native", () => ({ View: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.preferences,
  useAtomSet: () => mocks.save,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => new Set() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./settings-environment-filter", () => ({ useSettingsEnvironmentFilter: () => ({}) }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { children: ReactNode }) => <section>{props.children}</section>,
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-checked={props.selected} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { ThreadOrderSettings } from "./ThreadSettingsSections";

async function mount(preferences: unknown) {
  mocks.preferences = preferences;
  mocks.save.mockClear();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<ThreadOrderSettings />));
  return {
    buttons: [...container.querySelectorAll("button")],
    unmount: () => act(async () => root.unmount()),
  };
}

describe("ThreadOrderSettings", () => {
  it("checks the saved order and saves the one pressed", async () => {
    const view = await mount(AsyncResult.success({ threadOrder: "fixed" }));
    expect(view.buttons.map((b) => [b.textContent, b.getAttribute("aria-checked")])).toEqual([
      ["Recent activity", "false"],
      ["Fixed", "true"],
    ]);
    await act(async () => view.buttons[0]!.click());
    expect(mocks.save).toHaveBeenCalledWith({ threadOrder: "activity" });
    await view.unmount();
  });

  it("defaults to recent activity and locks the choices until preferences load", async () => {
    const ready = await mount(AsyncResult.success({}));
    expect(ready.buttons[0]!.getAttribute("aria-checked")).toBe("true");
    await ready.unmount();
    const loading = await mount(AsyncResult.initial());
    expect(loading.buttons.every((b) => b.disabled)).toBe(true);
    expect(loading.buttons.some((b) => b.getAttribute("aria-checked") === "true")).toBe(false);
    await loading.unmount();
  });
});
