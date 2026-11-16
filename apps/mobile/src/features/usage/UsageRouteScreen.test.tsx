import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks, Children } = vi.hoisted(() => ({
  Children: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  mocks: { environments: [] as unknown[] },
}));

vi.mock("react-native", () => ({ View: Children, RefreshControl: () => null }));
vi.mock("react-native-reanimated", () => ({
  default: { View: Children },
  FadeIn: { duration: () => ({ reduceMotion: () => undefined }) },
  ReduceMotion: { System: "system", Never: "never" },
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useRoute: () => ({ params: { tab: "usage" } }),
  useIsFocused: () => true,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("../../lib/appState", () => ({ useReduceMotionEnabled: () => false }));
vi.mock("../layout/workspace-content-width", () => ({
  useWorkspaceSettledContentWidth: () => 390,
}));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("../settings/components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("../../state/usage", () => ({
  useUsage: () => ({
    merged: { duplicateSources: [], daily: [], hourly: [] },
    environments: mocks.environments,
    selectedEnvironments: [],
    isPending: false,
    refresh: async () => undefined,
  }),
}));
vi.mock("./ChatGptUsageSummary", () => ({ ChatGptUsageSummary: () => null }));
vi.mock("./UsageDailyChart", () => ({ UsageDailyChart: () => null }));
vi.mock("./UsageBudgets", () => ({ UsageBudgets: () => null }));
// UsageLimitsSection and UsageLimitsPooled import each other; stub both whole.
vi.mock("./UsageLimitsSection", () => ({ useRefreshLimits: () => ({ refresh: vi.fn() }) }));
vi.mock("./UsageLimitsPooled", () => ({ UsageLimitsSection: () => null }));
vi.mock("./usageProviders", () => ({
  PROVIDER_LABEL: {},
  useProviderColors: () => ({}),
  useUsageMixColors: () => ({}),
}));

import {
  connectEnvironmentToSee,
  selectEnvironmentToSee,
} from "@t3tools/client-runtime/settings-empty-selection";

import { UsageRouteScreen } from "./UsageRouteScreen";

describe("UsageRouteScreen", () => {
  it.each([
    ["asks for an environment when there is none", [], connectEnvironmentToSee("usage")],
    [
      "asks to pick one when none is selected",
      [{ environmentId: "mac", label: "Mac" }],
      selectEnvironmentToSee("usage"),
    ],
  ] as const)("%s", async (_name, environments, expected) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.environments = [...environments];
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<UsageRouteScreen />));
    expect(container.textContent).toContain(expected);
    await act(async () => root.unmount());
  });
});
