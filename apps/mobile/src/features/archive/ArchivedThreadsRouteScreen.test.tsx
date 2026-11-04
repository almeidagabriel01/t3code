import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  screen: null as
    | null
    | (Record<string, (...args: never[]) => unknown> & {
        archivedProjects: Array<{ title: string; projectRefs: unknown[] }>;
      }),
  canOrganizeRefs: vi.fn(() => true),
  setScopeArchived: vi.fn(),
  projects: [] as unknown[],
}));
const project = (id: string, title: string, archivedAt: string | null) => ({
  environmentId: "hub",
  id,
  title,
  workspaceRoot: `/w/${id}`,
  archivedAt,
});

vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => undefined }));
vi.mock("../../state/assistants", () => ({
  useAssistantEntries: () => ({ active: [], archived: [] }),
  restoreAssistantConversation: vi.fn(),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({
    savedConnectionsById: { hub: { environmentId: "hub", environmentLabel: "Hub" } },
  }),
}));
vi.mock("../home/useThreadListActions", () => ({
  useArchivedThreadListActions: () => ({ unarchiveThread: vi.fn(), confirmDeleteThread: vi.fn() }),
}));
vi.mock("./useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
  useArchivedThreadSnapshots: () => ({
    error: null,
    isLoading: false,
    refresh: vi.fn(),
    snapshots: [],
  }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../home/home-list-options", () => ({
  useHomeListOptions: () => ({ options: { projectGroupingMode: "separate" } }),
}));
vi.mock("../projects/useProjectOrganize", () => ({
  useProjectOrganize: () => ({
    canOrganizeRefs: mocks.canOrganizeRefs,
    setScopeArchived: mocks.setScopeArchived,
  }),
}));
vi.mock("./ArchivedThreadsScreen", () => ({
  ArchivedThreadsScreen: (props: NonNullable<typeof mocks.screen>) => {
    mocks.screen = props;
    return null;
  },
}));

import { ArchivedThreadsRouteScreen } from "./ArchivedThreadsRouteScreen";

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(window.document.createElement("div"));
  await act(() => root.render(<ArchivedThreadsRouteScreen />));
  return () => act(() => root.unmount());
}

beforeEach(() => {
  mocks.canOrganizeRefs.mockReset().mockReturnValue(true);
  mocks.setScopeArchived.mockReset();
  mocks.projects = [project("a", "Alpha", "2026-06-02T00:00:00.000Z"), project("b", "Beta", null)];
});

describe("ArchivedThreadsRouteScreen archived projects", () => {
  it("passes only archived projects and unarchives the one pressed", async () => {
    const unmount = await mount();
    const { archivedProjects } = mocks.screen!;
    expect(archivedProjects.map((item) => item.title)).toEqual(["Alpha"]);
    expect(mocks.screen!.canUnarchiveProject!(archivedProjects[0] as never)).toBe(true);
    expect(mocks.canOrganizeRefs).toHaveBeenCalledWith(archivedProjects[0]!.projectRefs);

    mocks.screen!.onUnarchiveProject!(archivedProjects[0] as never);
    expect(mocks.setScopeArchived).toHaveBeenCalledWith(archivedProjects[0]!.projectRefs, false);
    await unmount();
  });

  it("narrows the list with the search query", async () => {
    const unmount = await mount();
    await act(async () => mocks.screen!.onSearchQueryChange!("zzz" as never));
    expect(mocks.screen!.archivedProjects).toEqual([]);
    await unmount();
  });
});
