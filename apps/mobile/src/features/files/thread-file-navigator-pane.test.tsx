import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  worktreePath: "/worktrees/p/feat" as string | null,
  cleaned: false,
  cleanedArgs: vi.fn(),
  notice: vi.fn(),
  refresh: vi.fn(),
  tree: vi.fn(),
  explorerInput: vi.fn(),
  rowMenu: vi.fn(),
  setExpandedPaths: vi.fn(),
  selectPath: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("@t3tools/client-runtime/state/filesystem", () => ({
  resolveFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../../state/session", () => ({ environmentSession: { sessionStateAtom: () => "s" } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ isReady: true, presentation: null }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "env", id: "thread" } }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadWorktreePath: mocks.worktreePath }),
}));
vi.mock("../threads/ThreadWorkspaceNotice", () => ({
  useThreadWorkspaceCleaned: (...args: unknown[]) => {
    mocks.cleanedArgs(...args);
    return mocks.cleaned;
  },
  ThreadWorkspaceNotice: (props: { onRestored?: () => void }) => {
    mocks.notice(props);
    return <aside>notice</aside>;
  },
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
vi.mock("./useFileTreeEntries", () => ({
  useFileTreeEntries: () => ({
    refresh: mocks.refresh,
    searchResultPaths: new Set(["src/a.ts", "lib/b.ts"]),
    setExpandedPaths: mocks.setExpandedPaths,
    selectPath: mocks.selectPath,
    selectedPath: null,
  }),
}));
vi.mock("./FileTreeBrowser", () => ({
  FileTreeBrowser: (props: unknown) => {
    mocks.tree(props);
    return <section>tree</section>;
  },
}));
vi.mock("./useFileExplorer", () => ({
  useFileExplorer: (input: unknown) => {
    mocks.explorerInput(input);
    return { headerMenu: { title: "New" }, rowMenu: mocks.rowMenu };
  },
}));
vi.mock("./preload-workspace-file", () => ({ preloadWorkspaceFileContents: vi.fn() }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));

import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";

function mount(cwd: string, onSelectFile: (path: string) => void = () => {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <ThreadFileNavigatorPane
        cwd={cwd}
        environmentId={"env" as never}
        projectName="p"
        selectedPath={null}
        onSelectFile={onSelectFile}
      />,
    ),
  );
  return { host, [Symbol.dispose]: () => act(() => root.unmount()) };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.worktreePath = "/worktrees/p/feat";
  mocks.cleaned = false;
  mocks.cleanedArgs.mockReset();
  mocks.notice.mockReset();
  mocks.tree.mockReset();
  mocks.explorerInput.mockReset();
  mocks.setExpandedPaths.mockReset();
});

it("replaces the file tree with the restore notice for a cleaned worktree", () => {
  mocks.cleaned = true;
  using view = mount("/worktrees/p/feat/apps");
  expect(view.host.textContent).toBe("notice");
  expect(mocks.cleanedArgs).toHaveBeenCalledWith("env", "thread", "/worktrees/p/feat");
  const props = mocks.notice.mock.calls[0]?.[0] as { onRestored: () => void } | undefined;
  props?.onRestored();
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

it("lists files while the worktree is ready", () => {
  using view = mount("/worktrees/p/feat");
  expect(view.host.textContent).toBe("tree");
});

it("does not treat a folder outside the thread's worktree as the cleaned one", () => {
  using view = mount("/worktrees/p/feat-other");
  expect(mocks.cleanedArgs).toHaveBeenCalledWith("env", "thread", null);
  expect(view.host.textContent).toBe("tree");
});

it("hands the tree its explorer menu and scopes search to a folder until cleared", () => {
  const onSelectFile = vi.fn();
  using view = mount("/worktrees/p/feat", onSelectFile);
  const input = mocks.explorerInput.mock.lastCall?.[0] as {
    onOpenFile: (path: string) => void;
    onFindInFolder: (path: string) => void;
  };
  expect(mocks.tree.mock.lastCall?.[0]).toMatchObject({
    rowMenu: mocks.rowMenu,
    searchScope: null,
  });
  input.onOpenFile("src/a.ts");
  expect(mocks.selectPath).toHaveBeenCalledWith("src/a.ts");
  expect(onSelectFile).toHaveBeenCalledWith("src/a.ts");

  act(() => input.onFindInFolder("src"));
  const scoped = mocks.tree.mock.lastCall?.[0] as {
    searchResultPaths: ReadonlySet<string>;
    searchScope: { path: string; onClear: () => void };
  };
  expect([...scoped.searchResultPaths]).toEqual(["src/a.ts"]);
  expect(scoped.searchScope.path).toBe("src");
  const update = mocks.setExpandedPaths.mock.lastCall?.[0] as (
    current: ReadonlySet<string>,
  ) => ReadonlySet<string>;
  expect([...update(new Set(["lib"]))]).toEqual(["lib", "src"]);
  act(() => scoped.searchScope.onClear());
  expect(mocks.tree.mock.lastCall?.[0]).toMatchObject({ searchScope: null });
  expect(view.host.textContent).toBe("tree");
});
