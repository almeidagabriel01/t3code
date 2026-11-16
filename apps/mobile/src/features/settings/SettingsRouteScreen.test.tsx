import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    selectedProjectKeys: null as ReadonlySet<string> | null,
    selectedProjectGroups: null as
      | null
      | { key: string; label: string; members: { project: unknown }[] }[],
    integrationIds: [] as string[],
    query: "",
    searching: [] as boolean[],
    selectedTargets: [] as { environmentId: string }[],
  },
}));

const local = { environmentId: "local" };
const projectIn = (environmentId: string, title: string) => ({
  environmentId,
  id: title,
  title,
  workspaceRoot: `/${title}`,
});

vi.mock("react-native", () => ({ View: Children, Platform: { OS: "ios" } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({}),
  useNavigationState: () => null,
  useRoute: () => ({ name: "Settings" }),
}));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({}), useUser: () => ({}) }));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveProjectGroupLabel: ({ representative }: { representative: { title: string } }) =>
    representative.title,
}));
// Settings search reads the tab labels, so only the layout queries are stubbed.
vi.mock("../layout/workspace/navigation-tab-order", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/workspace/navigation-tab-order")>()),
  navigationCustomizationAvailable: () => false,
  overflowNavigationTabs: () => [],
}));
vi.mock("../layout/workspace/navigation-tabs", () => ({
  NAVIGATION_TAB_ICONS: {},
  WORKSPACE_TAB_LABELS: {},
  useNavigationTabOrder: () => [],
  useHiddenNavigationTabs: () => [],
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  currentWorkspaceSelections: () => ({}),
}));
vi.mock("../layout/workspace/workspace-tab-navigation", () => ({
  rememberedSettingsPage: () => null,
}));
vi.mock("../layout/workspace/useSelectWorkspaceTab", () => ({ useSelectWorkspaceTab: () => null }));
vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ state: { tabs: { settings: { query: mocks.query } } } }),
}));
vi.mock("../layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: {} }),
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/Pane", () => ({ usePaneRole: () => "content" }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("../../state/assistants", () => ({ useAssistantsEnvironmentIds: () => [] }));
vi.mock("../../state/integrations", () => ({
  useIntegrationsEnvironmentIds: () => mocks.integrationIds,
  // The live feed's names, as the hook returns them while it subscribes.
  useIntegrationSearchNames: (searching: boolean) => {
    mocks.searching.push(searching);
    return searching ? ["Linear"] : [];
  },
}));
vi.mock("../../state/kanban", () => ({ useHasKanbanEnvironments: () => false }));
vi.mock("../../state/imessageChannel", () => ({ useImessageEnvironmentIds: () => [] }));
vi.mock("../../state/telegramChannel", () => ({ useTelegramEnvironmentIds: () => [] }));
vi.mock("../../state/macPermissions", () => ({ useMacEnvironmentIds: () => [] }));
vi.mock("../../state/device", () => ({ useDeviceEnvironmentIds: () => [] }));
vi.mock("../../state/macPermissions", () => ({
  useMacEnvironmentIds: () => [],
  useComputerUseHostEnvironmentIds: () => [],
}));
vi.mock("../../state/memory", () => ({ useHasMemoryEnvironments: () => false }));
vi.mock("../../state/notes", () => ({ useHasNotesEnvironments: () => false }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ items: [] }),
}));
vi.mock("./components/SettingsSection", async () => ({
  SettingsSection: Children,
  SettingsSidebarContext: (await import("react")).createContext(null),
}));
vi.mock("./settings-navigation", () => ({ openSettings: () => {} }));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <b data-symbol={props.name} />,
}));
vi.mock("../../components/ui/RowPressable", () => ({
  RowPressable: (props: {
    disabled?: boolean;
    accessibilityState?: { disabled?: boolean };
    children: ReactNode;
  }) => (
    <button
      disabled={props.disabled}
      data-a11y-disabled={String(props.accessibilityState?.disabled)}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/ListRowLayout", () => ({
  ListRowLayout: (props: { disabled?: boolean; accessory?: ReactNode }) => (
    <s data-dimmed={String(Boolean(props.disabled))}>{props.accessory}</s>
  ),
}));
// The real row draws inside, so its disabled state and chevron are what a user gets.
vi.mock("./components/SettingsRow", async (importOriginal) => {
  const { SettingsRow } = await importOriginal<typeof import("./components/SettingsRow")>();
  return {
    SettingsRow: (props: Parameters<typeof SettingsRow>[0]) => (
      <i
        data-label={props.label}
        data-value={props.value}
        data-target={props.target}
        data-icon={String(props.icon)}
      >
        <SettingsRow {...props} />
      </i>
    ),
  };
});
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.selectedTargets,
    selectedProjectKeys: mocks.selectedProjectKeys,
    selectedProjectGroups: mocks.selectedProjectGroups,
  }),
}));

import { WorkspaceSettingsList } from "./SettingsRouteScreen";

let root: Root;
let container: HTMLDivElement;
const projectsValue = () =>
  container.querySelector<HTMLElement>('[data-label="Projects"]')!.dataset.value;
const group = (key: string, label: string, ...projects: unknown[]) => ({
  key,
  label,
  members: projects.map((project) => ({ project })),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.selectedProjectKeys = null;
  mocks.selectedProjectGroups = null;
  mocks.integrationIds = [];
  mocks.query = "";
  mocks.searching = [];
  mocks.selectedTargets = [local];
});
afterEach(() => act(() => root.unmount()));

describe("Projects row of the Settings list", () => {
  it.each([
    ["all projects", null, null, undefined],
    ["one project", ["a"], [group("a", "Alpha", projectIn("local", "Alpha"))], "Alpha"],
    [
      "several projects",
      ["a", "b"],
      [group("a", "Alpha", projectIn("local", "Alpha")), group("b", "Beta")],
      "2 projects",
    ],
    ["only keys of projects that are gone", ["gone"], [], "Unavailable project"],
    [
      "one project with no checkout on the selected environments",
      ["a"],
      [group("a", "Alpha", projectIn("elsewhere", "Alpha"))],
      "Alpha",
    ],
  ] as const)("shows %s", (_name, keys, groups, expected) => {
    mocks.selectedProjectKeys = keys && new Set(keys);
    mocks.selectedProjectGroups = groups && [...groups];
    act(() => root.render(<WorkspaceSettingsList />));
    expect(projectsValue()).toBe(expected);
  });
});

describe("Integrations row of the Settings list", () => {
  it("opens Integrations beside the agent pages only when an environment has them", () => {
    act(() => root.render(<WorkspaceSettingsList />));
    expect(container.querySelector('[data-label="Integrations"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mocks.integrationIds = ["local"];
    act(() => root.render(<WorkspaceSettingsList />));
    const row = container.querySelector<HTMLElement>('[data-label="Integrations"]')!;
    expect(row.dataset.target).toBe("SettingsIntegrations");
    expect(row.dataset.icon).toBe("cable.connector");
    expect(row.previousElementSibling?.getAttribute("data-label")).toBe("MCP servers & skills");
    // No search, no subscription; a search subscribes and finds the page by a live name.
    expect(mocks.searching.every((searching) => !searching)).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    mocks.query = "linear";
    act(() => root.render(<WorkspaceSettingsList />));
    expect(mocks.searching.at(-1)).toBe(true);
    expect(
      [...container.querySelectorAll("[data-label]")].map((node) =>
        node.getAttribute("data-label"),
      ),
    ).toEqual(["Integrations"]);
  });
});

describe("Server pages of the Settings list", () => {
  const serverPages = [
    ["Providers", "person.crop.circle"],
    ["Threads", "text.bubble"],
    ["MCP servers & skills", "hammer"],
    ["Source control", "arrow.triangle.branch"],
    ["Worktrees", "square.on.square"],
    ["Maintenance", "arrow.clockwise"],
  ] as const;
  const rowState = (label: string) => {
    const row = container.querySelector<HTMLElement>(`[data-label="${label}"]`)!;
    return {
      icon: row.dataset.icon,
      disabled: row.querySelector("button")!.disabled,
      announcedDisabled: row.querySelector("button")!.dataset.a11yDisabled,
      dimmed: row.querySelector("s")!.dataset.dimmed,
      chevron: row.querySelector('[data-symbol="chevron.right"]') !== null,
    };
  };

  it.each([
    ["with no environment, look and read as disabled, without a chevron", [], true],
    ["with an environment, open their page", [local], false],
  ] as const)("%s", (_name, targets, off) => {
    mocks.selectedTargets = [...targets];
    act(() => root.render(<WorkspaceSettingsList />));
    for (const [label, icon] of serverPages) {
      expect(rowState(label)).toEqual({
        icon,
        disabled: off,
        announcedDisabled: String(off),
        dimmed: String(off),
        chevron: !off,
      });
    }
  });
});
