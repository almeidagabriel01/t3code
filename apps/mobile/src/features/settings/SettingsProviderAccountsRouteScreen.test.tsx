import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  mocks: { available: [] as Array<{ environmentId: string; label: string }> },
}));

vi.mock("react-native", () => ({
  View: Children,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <p>{props.children}</p>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/Menu", () => ({ Menu: Children }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: Children }));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: Children }));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: Children }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: Children }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentsScopeAccess: () => new Map() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ id: "environment", items: [] }),
}));
vi.mock("./ClaudeAccounts", () => ({ AddClaudeAccount: Children, ClaudeAccount: Children }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({ availableTargets: mocks.available, selectedTargets: [] }),
}));

import {
  CONNECT_ENVIRONMENT_FOR_PROVIDERS,
  emptyEnvironmentSelectionText,
} from "@t3tools/client-runtime/settings-empty-selection";

import { SettingsProviderAccountsRouteScreen } from "./SettingsProviderAccountsRouteScreen";

async function text() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SettingsProviderAccountsRouteScreen />));
  const content = host.textContent ?? "";
  await act(async () => root.unmount());
  return content;
}

afterEach(() => {
  mocks.available = [];
});

describe("SettingsProviderAccountsRouteScreen", () => {
  it("explains an empty selection", async () => {
    expect(await text()).toBe(
      emptyEnvironmentSelectionText(CONNECT_ENVIRONMENT_FOR_PROVIDERS, false),
    );
    mocks.available = [{ environmentId: "a", label: "Mac" }];
    expect(await text()).toBe(
      emptyEnvironmentSelectionText(CONNECT_ENVIRONMENT_FOR_PROVIDERS, true),
    );
  });
});
