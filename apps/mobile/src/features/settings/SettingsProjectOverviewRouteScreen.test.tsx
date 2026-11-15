import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    selectedKeys: null as ReadonlySet<string> | null,
    liveKeys: null as ReadonlySet<string> | null,
    selectAllProjects: vi.fn(),
    leave: vi.fn(),
    confirm: vi.fn(),
    deleteProject: vi.fn(),
  },
}));

const target = {
  environmentId: "local",
  label: "Local",
  displayUrl: null,
  serverConfig: { environment: { capabilities: { projectOrganization: true } } },
};
const project = { environmentId: "local", id: "p1", title: "Alpha", workspaceRoot: "/alpha" };
const group = { key: "a", label: "Alpha", pinned: false, archived: false, members: [{ project }] };

vi.mock("react-native", () => ({
  View: Children,
  Platform: { OS: "ios" },
  Pressable: Children,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ isFocused: () => false }) }));
vi.mock("@t3tools/client-runtime/state/projects", () => ({
  planProjectRemoval: () => ({ targetKind: "project", confirmationMessage: "sure?" }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: () => false,
  squashAtomCommandFailure: (error: unknown) => error,
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveProjectGroupLabel: ({ representative }: { representative: { title: string } }) =>
    representative.title,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children, AppTextInput: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../assistants/ProjectAssistantAccessSection", () => ({
  ProjectAssistantAccessSection: () => null,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), confirm: mocks.confirm }));
vi.mock("../../components/ui/ListActionRow", () => ({
  ListActionRow: (props: { label: string; onPress: () => void }) => (
    <button onClick={props.onPress}>{props.label}</button>
  ),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { delete: {}, update: {} } }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => ({}) } }));
vi.mock("../../state/use-composer-drafts", () => ({
  clearComposerDraft: vi.fn(),
  composerDraftsAtom: {},
  findNewTaskDraftKeys: () => [],
  waitForComposerDraftsLoaded: () => Promise.resolve(),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["local"]),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.deleteProject }));
vi.mock("../../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsSwitchRow", () => ({ SettingsSwitchRow: () => null }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({ items: [] }),
}));
vi.mock("./settings-navigation", () => ({ leaveSettingsPage: mocks.leave }));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => false,
}));
vi.mock("../layout/workspace/workspace-tab-navigation", () => ({ DEFAULT_SETTINGS_PAGE: "x" }));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    availableTargets: [target],
    selectedTargets: [target],
    selectedProjectKeys: mocks.selectedKeys,
    selectedProjectGroups: mocks.selectedKeys === null ? null : [group],
    selectAllProjects: mocks.selectAllProjects,
    getSelectedProjectKeys: () => mocks.liveKeys,
  }),
}));

import { SettingsProjectOverviewRouteScreen } from "./SettingsProjectOverviewRouteScreen";

let root: Root;
let container: HTMLDivElement;
const render = () => act(() => root.render(<SettingsProjectOverviewRouteScreen />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.selectedKeys = null;
  mocks.liveKeys = null;
  mocks.selectAllProjects.mockReset();
  mocks.leave.mockReset();
  mocks.confirm.mockReset();
  mocks.deleteProject.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(() => act(() => root.unmount()));

describe("project overview with the multi-project filter", () => {
  it("asks for a project when none is selected", () => {
    render();
    expect(container.textContent).toMatch(/^Choose a project with the filter/);
  });

  it("asks for a single project when several are selected", () => {
    mocks.selectedKeys = new Set(["a", "b"]);
    render();
    expect(container.textContent).toMatch(/^Choose a single project with the filter/);
  });

  const removeProject = async (liveKeysAtConfirm: string[]) => {
    mocks.selectedKeys = new Set(["a"]);
    mocks.liveKeys = new Set(["a"]);
    render();
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Remove project",
    )!;
    act(() => button.click());
    mocks.liveKeys = new Set(liveKeysAtConfirm);
    await act(async () => mocks.confirm.mock.calls[0]![0].onConfirm());
  };

  it("resets the filter to all projects once the selected project is removed", async () => {
    await removeProject(["a"]);
    expect(mocks.deleteProject).toHaveBeenCalledOnce();
    expect(mocks.selectAllProjects).toHaveBeenCalledOnce();
  });

  it("leaves the filter alone when it moved to other projects during the removal", async () => {
    await removeProject(["a", "b"]);
    expect(mocks.selectAllProjects).not.toHaveBeenCalled();
  });
});
