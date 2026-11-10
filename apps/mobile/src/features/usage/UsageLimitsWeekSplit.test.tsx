import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { mocks } = vi.hoisted(() => ({
  mocks: { presentations: new Map<string, unknown>(), navigate: vi.fn() },
}));

vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  View: (props: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    onLayout?: (event: unknown) => void;
  }) => {
    useEffect(() => {
      props.onLayout?.({ nativeEvent: { layout: { width: 200, height: 30 } } });
    }, []);
    return (
      <div data-testid={props.testID} aria-label={props.accessibilityLabel}>
        {props.children}
      </div>
    );
  },
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-svg", () => ({
  Svg: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Defs: () => null,
  Path: () => null,
  Pattern: () => null,
  Rect: (props: { x?: string; width?: string; opacity?: number }) => (
    <i data-testid="rect" data-x={props.x} data-width={props.width} data-opacity={props.opacity} />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.presentations,
  useAtomMount: () => undefined,
  RegistryContext: { _currentValue: null },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../settings/components/SettingsScreen", () => ({
  SettingsScreen: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: {} },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: {} } }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => false,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/entities", () => ({ useProjects: () => [], useThreadShells: () => [] }));
vi.mock("../../lib/clock", () => ({ useNowMinuteMs: () => 0 }));
vi.mock("../threads/useOpenLinkedThread", () => ({ useOpenLinkedThread: () => vi.fn() }));
vi.mock("./AccountSessions", () => ({ AccountSessions: () => null }));
vi.mock("./usageLimitsRefresh", () => ({
  environmentIdsKey: () => "",
  limitsAutoRefreshSetAtom: {},
  limitsRefreshFailuresAtom: {},
  refreshEnvironmentLimits: vi.fn(),
}));
vi.mock("./usageProviders", () => ({
  usageProviderKind: () => "codex",
  useProviderColors: () => ({ codex: "#10a37f" }),
}));
vi.mock("./usagePaceSettings", () => ({
  PaceDetail: () => null,
  paceTone: () => "",
  UsagePaceSettingsSection: () => null,
  UsageResetSettingsSection: () => null,
  useUsagePaceSettings: () => ({
    pace: false,
    projection: false,
    dailyBudget: false,
    showSessions: false,
    resetDisplay: "relative",
    watch: 75,
    critical: 90,
  }),
}));

import { AccountLimits } from "./UsageLimitsSection";
import { UsageLimitAccountScreen, UsageLimitsSection } from "./UsageLimitsPooled";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const environmentId = EnvironmentId.make("env");

const week: ServerProviderUsageWindow = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 86,
  weekAllowancePercent: 60,
};
const fable: ServerProviderUsageWindow = {
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent: 40,
  weekUsedSharePercent: 22,
};
const usageLimits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [week, fable] };
const SPLIT = "Week 14% left, used Fable 22%, other models 64%";

const provider = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits,
} as unknown as ServerProvider;

async function mount(element: ReactNode) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.presentations = new Map([
    [
      environmentId,
      { entry: { target: { label: "Mac" } }, serverConfig: { providers: [provider] } },
    ],
  ]);
  const container = window.document.createElement("div");
  await act(() => createRoot(container).render(element));
  return container;
}

describe("weekly model split", () => {
  it("draws the model share and the allowance on the account's weekly bar", async () => {
    const container = await mount(
      <AccountLimits
        driver={provider.driver}
        label="Claude"
        instanceLabel="Claude"
        detail={undefined}
        limits={usageLimits}
        now={now}
        first
      />,
    );
    expect(container.querySelector(`[aria-label="${SPLIT}"]`)).not.toBeNull();
    expect(container.querySelectorAll("[data-testid=week-split-model]")).toHaveLength(1);
    expect(container.textContent).toContain("Up to 60% of the weekly limit");
  });

  it("labels the pooled segment with the split and shades the model share at its used end", async () => {
    const container = await mount(
      <UsageLimitsSection now={now} failedLabels={[]} selectedEnvironmentIds={null} />,
    );
    const segment = [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("Segment 1"),
    );
    expect(segment?.getAttribute("aria-label")).toContain(`14% left. ${SPLIT}`);
    const rects = [...container.querySelectorAll<HTMLElement>("[data-testid=rect]")].filter(
      (rect) => rect.dataset.opacity === "0.18",
    );
    expect(rects.map((rect) => [rect.dataset.x, rect.dataset.width])).toEqual([["78%", "22%"]]);
  });

  it("shows the split and allowance lines on the account detail screen", async () => {
    const container = await mount(
      <UsageLimitAccountScreen
        {...({
          route: {
            params: {
              accountKey: `${environmentId}:claude`,
              windowId: "seven_day",
              windowKind: "weekly",
              environmentIds: null,
              now,
            },
          },
        } as unknown as Parameters<typeof UsageLimitAccountScreen>[0])}
      />,
    );
    expect(container.textContent).toContain(SPLIT);
    expect(container.textContent).toContain("Up to 60% of the weekly limit");
  });
});
