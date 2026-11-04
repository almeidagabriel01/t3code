import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const { Pass } = vi.hoisted(() => ({
  Pass: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  RefreshControl: () => null,
  useWindowDimensions: () => ({ width: 400 }),
  View: Pass,
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: Pass,
  useNativeGesture: () => ({}),
}));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => undefined }) }));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: (props: {
    data: unknown[];
    renderItem: (input: { item: unknown }) => ReactNode;
    ListEmptyComponent: ReactNode;
  }) => (
    <div>
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item) => (
            <div key={(item as { key: string }).key}>{props.renderItem({ item })}</div>
          ))}
    </div>
  ),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: Pass }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Pass }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: (props: { title: string }) => <p>{props.title}</p>,
}));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
}));
vi.mock("../../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../components/RelativeTime", () => ({ RelativeTime: () => null }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../home/thread-swipe-actions", () => ({ ThreadSwipeable: Pass }));
vi.mock("../settings/components/SettingsScreen", () => ({ SettingsScreenContent: Pass }));
vi.mock("./ArchivedProjectRow", () => ({
  ArchivedProjectRow: (props: {
    item: { title: string };
    canUnarchive: boolean;
    onUnarchive: (item: unknown) => void;
  }) => (
    <button disabled={!props.canUnarchive} onClick={() => props.onUnarchive(props.item)}>
      {props.item.title}
    </button>
  ),
}));

import { ArchivedThreadsScreen } from "./ArchivedThreadsScreen";

const alpha = { key: "alpha", title: "Alpha", representative: {}, projectRefs: [] } as never;
const props = {
  environments: [],
  error: null,
  groups: [],
  archivedProjects: [alpha],
  canUnarchiveProject: () => true,
  onUnarchiveProject: vi.fn(),
  isLoading: false,
  searchQuery: "",
  selectedEnvironmentId: null,
  sortOrder: "newest" as const,
  onDeleteThread: vi.fn(),
  onEnvironmentChange: vi.fn(),
  onRefresh: vi.fn(),
  onSearchQueryChange: vi.fn(),
  onSortOrderChange: vi.fn(),
  onUnarchiveThread: vi.fn(),
  assistantRestoreFor: () => undefined,
};

async function mount(overrides: Partial<typeof props>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = window.document.createElement("div");
  const root = createRoot(container);
  await act(() => root.render(<ArchivedThreadsScreen {...props} {...overrides} />));
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("ArchivedThreadsScreen archived projects", () => {
  it("lists an archived project in place of the empty state and unarchives it", async () => {
    props.onUnarchiveProject.mockReset();
    const { container, unmount } = await mount({});
    expect(container.textContent).toBe("Alpha");
    await act(async () => container.querySelector("button")!.click());
    expect(props.onUnarchiveProject).toHaveBeenCalledWith(alpha);
    await unmount();
  });

  it("disables unarchive when this connection cannot change the project", async () => {
    const { container, unmount } = await mount({ canUnarchiveProject: () => false });
    expect(container.querySelector("button")!.disabled).toBe(true);
    await unmount();
  });

  it("shows the empty state only without archived threads or projects", async () => {
    const { container, unmount } = await mount({ archivedProjects: [] });
    expect(container.textContent).toBe("No archived threads");
    await unmount();
  });

  it("is not an initial load while only archived projects are known", async () => {
    const { container, unmount } = await mount({ isLoading: true });
    expect(container.textContent).toBe("Alpha");
    await unmount();
  });
});
