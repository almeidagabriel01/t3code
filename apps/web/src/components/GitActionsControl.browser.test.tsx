import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";

vi.mock(import("../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === null
        ? null
        : { isRepo: false, workingTree: { files: [] }, sourceControlProviders: [] },
    error: null,
    refresh: vi.fn(),
  })) as never,
}));

import GitActionsControl from "./GitActionsControl";

const activeThreadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

// Mounted bare: the control needs no routes to show its initialize row.
const bare = { router: false } as const;

it("offers to initialize git in a folder that is not a repository", async () => {
  await using screen = await render(
    <GitActionsControl gitCwd="/project" activeThreadRef={activeThreadRef} />,
    bare,
  );
  await expect.element(screen.getByText("Initialize Git")).toBeInTheDocument();
});

it("shows no initialize row for a managed worktree, whose folder is restored instead", async () => {
  await using screen = await render(
    <GitActionsControl
      gitCwd="/worktrees/p/feat"
      activeThreadRef={activeThreadRef}
      allowInitialize={false}
    />,
    bare,
  );
  await expect.element(screen.getByText("Initialize Git")).not.toBeInTheDocument();
});
