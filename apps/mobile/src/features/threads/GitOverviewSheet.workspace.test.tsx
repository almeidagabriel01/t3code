import type { ReactNode } from "react";
import { act, createContext } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { stubModules } from "../../testing/stubModules";

const mocks = vi.hoisted(() => ({
  cleaned: false,
  worktreePath: "/worktrees/p/feat" as string | null,
  refreshGit: vi.fn(),
  notice: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  RefreshControl: () => null,
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn(), dispatch: vi.fn(), navigate: vi.fn() }),
  StackActions: {},
  CommonActions: {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: { subtitle?: string }) => <header>{props.subtitle}</header>,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/ListSection", () => ({
  ListSection: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../../components/ui/ListRow", () => ({ ListRow: () => null }));
vi.mock("../layout/workspace-inspector-sheet", () => ({
  InspectorSheetContext: createContext(null),
}));
vi.mock("../../lib/cn", () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(" ") }));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "env", id: "thread", branch: "feat" },
    selectedThreadProject: null,
    selectedEnvironmentRuntime: null,
  }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/worktrees/p/feat",
    selectedThreadWorktreePath: mocks.worktreePath,
  }),
}));
vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canChangeThreadBranch: true,
    refreshSelectedThreadGitStatus: mocks.refreshGit,
  }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => "status" } }));
vi.mock("./git/gitSheetComponents", () => ({
  menuItemIconName: () => "icon",
  statusSummary: () => "No status yet",
}));
vi.mock("./LinkedPullRequestList", () => ({
  LinkedPullRequestRow: () => null,
  linkedPullRequestKey: () => "key",
  useLinkedPullRequestLines: () => [],
}));
vi.mock("./useLinkedPullRequestActions", () => ({
  useLinkedPullRequestActions: () => ({ canLink: false }),
}));
vi.mock("./ThreadWorkspaceNotice", () => ({
  useThreadWorkspaceCleaned: (_env: unknown, _thread: unknown, path: string | null) =>
    mocks.cleaned && path !== null,
  ThreadWorkspaceNotice: (props: { worktreePath: string | null; onRestored?: () => void }) => {
    mocks.notice(props);
    return null;
  },
}));

stubModules(import.meta.dirname, [
  "../../components/ui/Dialog",
  "../../components/ui/AppText",
  "../../native/useOpenPullRequest",
]);
const { GitOverviewSheet } = await import("./git/GitOverviewSheet");

function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() =>
    root.render(
      <GitOverviewSheet
        route={{ params: { environmentId: "env", threadId: "thread" } } as never}
      />,
    ),
  );
  return { host, [Symbol.dispose]: () => act(() => root.unmount()) };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.cleaned = false;
  mocks.worktreePath = "/worktrees/p/feat";
  mocks.refreshGit.mockReset();
  mocks.notice.mockReset();
});

it("shows a cleaned worktree in the header instead of the git status", () => {
  mocks.cleaned = true;
  using view = mount();
  expect(view.host.querySelector("header")?.textContent).toBe("Worktree cleaned up");
});

it("keeps the git status for a ready worktree", () => {
  using view = mount();
  expect(view.host.querySelector("header")?.textContent).toBe("No status yet");
});

it("rereads the git status once the notice restored the worktree", () => {
  using _view = mount();
  const props = mocks.notice.mock.calls[0]?.[0] as { worktreePath: string; onRestored: () => void };
  expect(props.worktreePath).toBe("/worktrees/p/feat");
  props.onRestored();
  expect(mocks.refreshGit).toHaveBeenCalledOnce();
});
