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
}));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({}), useUser: () => ({}) }));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveProjectGroupLabel: ({ representative }: { representative: { title: string } }) =>
    representative.title,
}));
vi.mock("../layout/workspace/navigation-tab-order", () => ({
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
vi.mock("../layout/workspace/WorkspaceTabsContext", () => ({ useWorkspaceTabs: () => null }));
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
vi.mock("../../state/kanban", () => ({ useHasKanbanEnvironments: () => false }));
vi.mock("../../state/imessageChannel", () => ({ useImessageEnvironmentIds: () => [] }));
vi.mock("../../state/telegramChannel", () => ({ useTelegramEnvironmentIds: () => [] }));
vi.mock("../../state/macPermissions", () => ({ useMacEnvironmentIds: () => [] }));
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
vi.mock("./components/SettingsRow", () => ({
  SettingsRow: (props: { label: string; value?: string }) => (
    <i data-label={props.label} data-value={props.value} />
  ),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [local],
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
