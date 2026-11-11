import type { ProjectEntry } from "@t3tools/contracts";
import { act, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ menus: [] as unknown[] }));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  RefreshControl: () => null,
  Pressable: (props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onLongPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      data-long-press={props.onLongPress ? "yes" : "no"}
      onClick={props.onPress}
      onContextMenu={props.onLongPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: <T,>(props: {
    data: readonly T[];
    keyExtractor: (item: T) => string;
    renderItem: (input: { item: T }) => ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </div>
  ),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../../components/ui/useBarInset", () => ({
  useContentBottomInset: () => 0,
  useContentTopInset: () => 0,
}));
// Like Android's menu: hands a long-press trigger to the row it wraps.
vi.mock("../../components/ui/Menu", () => ({
  Menu: (props: {
    children: ReactNode;
    actions: readonly unknown[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => {
    mocks.menus.push(props);
    const child = props.children as ReactElement<{ onLongPress?: () => void }>;
    return isValidElement(child)
      ? cloneElement(child, {
          onLongPress: () => props.onPressAction({ nativeEvent: { event: "rename" } }),
        })
      : null;
  },
}));

import { FileTreeBrowser } from "./FileTreeBrowser";

const entries: ReadonlyArray<ProjectEntry> = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];

function mount(props: Partial<Parameters<typeof FileTreeBrowser>[0]>) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <FileTreeBrowser
        revealSelection={() => {}}
        expandedPaths={new Set()}
        setExpandedPaths={() => {}}
        entries={entries}
        error={null}
        isPending={false}
        isRefreshing={false}
        searchQuery=""
        searchResultPaths={null}
        searchTruncated={false}
        selectedPath={null}
        loadingDirectories={new Set()}
        onLoadDirectory={() => {}}
        onRefresh={() => {}}
        onSelectFile={() => {}}
        {...props}
      />,
    ),
  );
  return { host, [Symbol.dispose]: () => act(() => root.unmount()) };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.menus = [];
});

it("opens each row's explorer menu on long press and skips rows with no actions", () => {
  const picked = vi.fn();
  const rowMenu = vi.fn((path: string, kind: string) => ({
    actions: kind === "file" ? [{ id: "rename", title: "Rename" }] : [],
    onPressAction: (id: string) => picked(path, id),
  }));
  using view = mount({ rowMenu });
  expect(rowMenu.mock.calls).toEqual([
    ["src", "directory", false],
    ["README.md", "file", false],
  ]);
  const file = view.host.querySelector<HTMLButtonElement>('[aria-label="README.md"]')!;
  const folder = view.host.querySelector<HTMLButtonElement>('[aria-label="src"]')!;
  expect(folder.dataset.longPress).toBe("no");
  expect(file.dataset.longPress).toBe("yes");
  act(() => file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(picked).toHaveBeenCalledWith("README.md", "rename");
  expect(mocks.menus).toHaveLength(1);
});

it("shows the folder a search is limited to with a way back to all files", () => {
  const onClear = vi.fn();
  using view = mount({ searchScope: { path: "src", onClear } });
  expect(view.host.textContent).toContain("Searching in src/");
  act(() => view.host.querySelector<HTMLButtonElement>('[aria-label="Search all files"]')!.click());
  expect(onClear).toHaveBeenCalledOnce();
});
