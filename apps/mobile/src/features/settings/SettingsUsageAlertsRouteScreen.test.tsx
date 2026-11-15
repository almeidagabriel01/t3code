import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const env = "env" as EnvironmentId;
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  navigate: vi.fn(),
  allowed: true,
  autonomy: true,
  ignorePause: true,
  alerts: {} as Record<string, unknown>,
  windows: [] as Array<{ id: string; label: string }>,
  enabled: true,
  targets: [true] as boolean[],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { key: string }) =>
    atom.key === "providers"
      ? new Map([
          [
            env,
            [
              {
                instanceId: "claude",
                driver: "claudeAgent",
                displayName: "Claude",
                enabled: mocks.enabled,
                usageLimits: { windows: mocks.windows },
              },
            ],
          ],
        ])
      : {
          autonomy: { enabled: mocks.autonomy },
          usageLimitAlerts: { ignoreAutonomyPause: mocks.ignorePause, instances: mocks.alerts },
        },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  View: (p: { children?: ReactNode }) => <div>{p.children}</div>,
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (p: { children?: ReactNode; accessibilityState?: { disabled?: boolean } }) => (
    <div aria-disabled={p.accessibilityState?.disabled}>{p.children}</div>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (p: { label: string; detail?: string; description?: string }) => (
    <span>
      {p.label}: {p.detail ?? p.description}
    </span>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (p: { title: string; detail: string }) => (
    <p data-empty>
      {p.title}. {p.detail}
    </p>
  ),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { providersByEnvironmentAtom: { key: "providers" } },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => ({ key: "settings" }),
    updateSettings: {},
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../state/session", () => ({
  useEnvironmentScopeAccess: () => (mocks.allowed ? "granted" : "missing"),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (p: { children?: ReactNode }) => <span>{p.children}</span>,
}));
vi.mock("../../components/ui/ListRow", () => ({
  ListRow: (p: { label: string; description: string; onPress: () => void }) => (
    <button data-note onClick={p.onPress}>
      {p.label}. {p.description}
    </button>
  ),
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: (p: { children?: ReactNode }) => <div>{p.children}</div>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: (p: {
    actions: Array<{ id: string; title: string; state: string }>;
    onPressAction: (e: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => (
    <div>
      {p.children}
      {p.actions.map((a) => (
        <button
          key={a.id}
          role="menuitemradio"
          aria-checked={a.state === "on"}
          onClick={() => p.onPressAction({ nativeEvent: { event: a.id } })}
        >
          {a.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({}),
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: (p: { children?: ReactNode }) => <div>{p.children}</div>,
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (p: { title: string; children: ReactNode }) => (
    <section aria-label={p.title}>{p.children}</section>
  ),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets.map((usageLimitAlerts, index) => ({
      environmentId: index === 0 ? env : `env-${index}`,
      label: index === 0 ? "Mac" : `PC ${index}`,
      serverConfig: { environment: { capabilities: { usageLimitAlerts } } },
    })),
  }),
}));

import { SettingsUsageAlertsRouteScreen } from "./SettingsUsageAlertsRouteScreen";

async function mount(input: Partial<typeof mocks> = {}) {
  Object.assign(mocks, {
    allowed: true,
    autonomy: true,
    ignorePause: true,
    alerts: {},
    windows: [],
    enabled: true,
    targets: [true],
    ...input,
  });
  mocks.update.mockClear();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SettingsUsageAlertsRouteScreen />));
  return { host, unmount: () => act(() => root.unmount()) };
}

const click = (el: Element | undefined) => act(async () => (el as HTMLElement).click());
const weekly = { id: "seven_day", label: "Weekly" };

describe("SettingsUsageAlertsRouteScreen", () => {
  it.each([true, false])(
    "shows window labels with the default and saved values (instance enabled: %s)",
    async (enabled) => {
      const { host, unmount } = await mount({
        enabled,
        windows: [weekly, { id: "five_hour", label: "Session" }],
        alerts: { claude: { windows: { five_hour: 30 } } },
      });
      const section = host.querySelector("section[aria-label=Claude]")!;
      expect(section.textContent).toContain("Weekly: 15% left");
      expect(section.textContent).toContain("Session: 30% left");
      // The shared description shows once for the screen, not on every row.
      expect(host.textContent?.split("Your assistant messages you once").length).toBe(2);
      expect(host.querySelector("[data-note]")).toBeNull();
      await unmount();
    },
  );

  it("writes the chosen threshold, off, or a return to the default, per window", async () => {
    const { host, unmount } = await mount({ windows: [weekly] });
    const items = [...host.querySelectorAll("[role=menuitemradio]")];
    expect(items.find((i) => i.getAttribute("aria-checked") === "true")?.textContent).toBe(
      "15% left",
    );
    await click(items.find((i) => i.textContent === "5% left"));
    await click(items.find((i) => i.textContent === "Off"));
    await click(items.find((i) => i.textContent === "15% left"));
    const sent = (n: number) =>
      mocks.update.mock.calls[n]![0].input.patch.usageLimitAlerts.instances.claude;
    expect(sent(0).windows).toEqual({ seven_day: 5 });
    expect(sent(1).windows).toEqual({ seven_day: "off" });
    // Picking the default clears the override.
    expect(sent(2).windows).toEqual({ seven_day: null });
    expect(typeof sent(0).timeZone).toBe("string");
    await unmount();
  });

  it("locks the row without permission: no menu opens and the row reads as disabled", async () => {
    const { host, unmount } = await mount({ windows: [weekly], allowed: false });
    const row = host.querySelector("[aria-disabled=true]")!;
    expect(row.textContent).toContain("Weekly");
    expect(host.querySelector("[role=menuitemradio]")).toBeNull();
    // The reason sits above the rows it explains.
    expect(host.textContent).toContain(
      "Limited permissions: This session can view Mac's providers but can't change their settings.",
    );
    expect(host.textContent!.indexOf("Limited permissions")).toBeLessThan(
      host.textContent!.indexOf("Weekly"),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    await unmount();
  });

  it("says alerts wait only while Autonomy is off and they may not get past it", async () => {
    const through = await mount({ windows: [weekly], autonomy: false });
    expect(through.host.querySelector("[data-note]")).toBeNull();
    expect(through.host.querySelector("[role=switch]")).toBeNull();
    await through.unmount();

    // A disabled instance or an alert set to Off has nothing to hold back.
    for (const quiet of [
      { enabled: false },
      { alerts: { claude: { windows: { seven_day: "off" } } } },
    ]) {
      const idle = await mount({
        windows: [weekly],
        autonomy: false,
        ignorePause: false,
        ...quiet,
      });
      expect(idle.host.querySelector("[data-note]")).toBeNull();
      await idle.unmount();
    }

    const waiting = await mount({ windows: [weekly], autonomy: false, ignorePause: false });
    const note = waiting.host.querySelector("[data-note]")!;
    expect(note.textContent).toContain("Alerts are paused");
    expect(note.textContent).toContain("so limit alerts wait. Change it in Assistants");
    expect(waiting.host.textContent!.indexOf("Alerts are paused")).toBeLessThan(
      waiting.host.textContent!.indexOf("Weekly"),
    );
    await click(note);
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsAssistants");
    await waiting.unmount();
  });

  it.each([
    { targets: [], text: "Select a connected environment.", rows: false },
    {
      targets: [false],
      text: "Update this server. Limit alerts need a newer T3 Code server.",
      rows: false,
    },
    { targets: [true, false], text: "PC 1 needs a server update to use limit alerts.", rows: true },
  ])(
    "explains what an environment selection of $targets can show",
    async ({ targets, text, rows }) => {
      const { host, unmount } = await mount({ windows: [weekly], targets });
      expect(host.textContent).toContain(text);
      expect(host.querySelector("section") !== null).toBe(rows);
      if (targets.length > 0) expect(host.textContent).not.toContain("Select a connected");
      await unmount();
    },
  );
});
