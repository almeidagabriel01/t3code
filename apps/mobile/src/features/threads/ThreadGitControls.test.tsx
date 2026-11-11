import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { stubModules } from "../../testing/stubModules";

const mocks = vi.hoisted(() => ({
  selected: null as { id: string; environmentId: string } | null,
  worktreePath: null as string | null,
  cleaned: false,
  cleanedArgs: vi.fn(),
}));

vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: mocks.selected }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadWorktreePath: mocks.worktreePath }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("./ThreadWorkspaceNotice", () => ({
  useThreadWorkspaceCleaned: (...args: unknown[]) => {
    mocks.cleanedArgs(...args);
    return mocks.cleaned;
  },
}));

stubModules(import.meta.dirname, [
  "../../components/ui/Dialog",
  "../../native/useOpenPullRequest",
  "../pull-requests/pullRequestGlyphs",
  "../terminal/terminalMenu",
]);
const { useThreadGitMenuDefinition } = await import("./ThreadGitControls");

function menuFor(threadId: string) {
  let menu: ReturnType<typeof useThreadGitMenuDefinition> = null;
  const Probe = () => {
    menu = useThreadGitMenuDefinition({
      environmentId: "env",
      threadId,
      currentBranch: "feat",
      gitStatus: null,
      gitOperationLabel: null,
      onPull: async () => {},
      onRunAction: async () => null,
    });
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return menu as unknown as { items: ReadonlyArray<Record<string, unknown>> };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.selected = { id: "thread", environmentId: "env" };
  mocks.worktreePath = "/worktrees/p/feat";
  mocks.cleaned = false;
  mocks.cleanedArgs.mockReset();
});

it("shows a cleaned worktree in place of the git status and disables the quick action", () => {
  mocks.cleaned = true;
  const { items } = menuFor("thread");
  expect(items[0]).toMatchObject({ subtitle: "Worktree cleaned up" });
  expect(items[1]).toMatchObject({ title: "Worktree cleaned up", disabled: true });
  expect(mocks.cleanedArgs).toHaveBeenCalledWith("env", "thread", "/worktrees/p/feat");
});

it("leaves the status alone for a ready worktree", () => {
  const { items } = menuFor("thread");
  expect(items[0]).not.toMatchObject({ subtitle: "Worktree cleaned up" });
  expect(items[1]).not.toMatchObject({ title: "Worktree cleaned up" });
});

it("asks about the worktree only for the selected thread", () => {
  menuFor("another-thread");
  expect(mocks.cleanedArgs).toHaveBeenCalledWith("env", "thread", null);
});
