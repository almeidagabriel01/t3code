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
  alerts: {} as Record<string, unknown>,
  windows: [] as Array<{ id: string; label: string }>,
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
                enabled: true,
                usageLimits: { windows: mocks.windows },
              },
            ],
          ],
        ])
      : atom.key === "allowed"
        ? mocks.allowed
        : { autonomy: { enabled: mocks.autonomy }, usageLimitAlerts: mocks.alerts },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native", () => ({
  View: (p: { children?: ReactNode }) => <div>{p.children}</div>,
  Pressable: (p: { children?: ReactNode; disabled?: boolean }) => (
    <div data-disabled={p.disabled}>{p.children}</div>
  ),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { providersByEnvironmentAtom: { key: "providers" } },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => ({ key: "settings" }),
    updateSettings: { permissionAtom: () => ({ key: "allowed" }) },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
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
    selectedTargets: [
      {
        environmentId: env,
        label: "Mac",
        serverConfig: { environment: { capabilities: { usageLimitAlerts: true } } },
      },
    ],
  }),
}));

import { SettingsUsageAlertsRouteScreen } from "./SettingsUsageAlertsRouteScreen";

async function mount(input: Partial<typeof mocks> = {}) {
  Object.assign(mocks, { allowed: true, autonomy: true, alerts: {}, windows: [], ...input });
  mocks.update.mockClear();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SettingsUsageAlertsRouteScreen />));
  return { host, unmount: () => act(() => root.unmount()) };
}

const click = (el: Element | undefined) => act(async () => (el as HTMLElement).click());
const weekly = { id: "seven_day", label: "Weekly" };

describe("SettingsUsageAlertsRouteScreen", () => {
  it("shows window labels with the default and saved values", async () => {
    const { host, unmount } = await mount({
      windows: [weekly, { id: "five_hour", label: "Session" }],
      alerts: { claude: { windows: { five_hour: 30 } } },
    });
    const section = host.querySelector("section[aria-label=Claude]")!;
    expect(section.textContent).toContain("Weekly");
    expect(section.textContent).toContain("15%");
    expect(section.textContent).toContain("Session");
    expect(section.textContent).toContain("30%");
    expect(section.textContent).toContain("Your assistant tells you once");
    expect(host.querySelector("[data-note]")).toBeNull();
    await unmount();
  });

  it("writes the chosen threshold, or off, per window", async () => {
    const { host, unmount } = await mount({ windows: [weekly] });
    const items = [...host.querySelectorAll("[role=menuitemradio]")];
    expect(items.find((i) => i.getAttribute("aria-checked") === "true")?.textContent).toBe("15%");
    await click(items.find((i) => i.textContent === "5%"));
    await click(items.find((i) => i.textContent === "Off"));
    const sent = (n: number) => mocks.update.mock.calls[n]![0].input.patch.usageLimitAlerts.claude;
    expect(sent(0).windows).toEqual({ seven_day: 5 });
    expect(sent(1).windows).toEqual({ seven_day: "off" });
    expect(typeof sent(0).timeZone).toBe("string");
    await unmount();
  });

  it("does not write without permission", async () => {
    const { host, unmount } = await mount({ windows: [weekly], allowed: false });
    expect(host.querySelector("[data-disabled=true]")).not.toBeNull();
    await click(host.querySelector("[role=menuitemradio]")!);
    expect(mocks.update).not.toHaveBeenCalled();
    await unmount();
  });

  it("explains paused notifications and links to Assistants settings", async () => {
    const { host, unmount } = await mount({ windows: [weekly], autonomy: false });
    const note = host.querySelector("[data-note]")!;
    expect(note.textContent).toContain("Assistant notifications are paused");
    await click(note);
    expect(mocks.navigate).toHaveBeenCalledWith("SettingsAssistants");
    await unmount();
  });
});
