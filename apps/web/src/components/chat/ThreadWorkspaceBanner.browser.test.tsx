import { EnvironmentId, ThreadId, type ThreadWorkspaceStatus } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  data: null as ThreadWorkspaceStatus | null,
  refresh: vi.fn(),
  restore: vi.fn(),
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: state.data, refresh: state.refresh })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      threadWorkspaceStatus: (() => null) as never,
      restoreThreadWorkspace: {
        ...actual.serverEnvironment.restoreThreadWorkspace,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.restore) as never,
}));

import { ThreadWorkspaceBanner } from "./ThreadWorkspaceBanner";

const element = (turnKey = "run-1") => (
  <ThreadWorkspaceBanner
    environmentId={EnvironmentId.make("env-1")}
    threadId={ThreadId.make("thread-1")}
    worktreePath="/worktrees/project/feat"
    turnKey={turnKey}
  />
);
// The banner needs no routes; mounting it bare keeps the test on its own behavior.
const bare = { router: false } as const;

function setup(data: ThreadWorkspaceStatus | null) {
  state.data = data;
  state.refresh.mockReset();
  state.restore.mockReset();
}

it("stays out of the way while the worktree is ready", async () => {
  setup({ state: "ready", snapshot: null });
  await using screen = await render(element(), bare);
  await expect.element(screen.getByRole("button", { name: "Restore" })).not.toBeInTheDocument();
});

it("explains a cleaned worktree without a snapshot and restores on click", async () => {
  setup({ state: "cleaned", snapshot: null });
  state.restore.mockResolvedValue({ _tag: "Success" });
  await using screen = await render(element(), bare);
  await expect.element(screen.getByText(/No saved changes remain/)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Restore" }).click();
  expect(state.restore).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-1" },
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("shows a failed restore's reason and keeps the button", async () => {
  setup({ state: "cleaned", snapshot: { capturedAt: "2026-11-01T12:00:00.000Z" } });
  state.restore.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("The saved changes conflict.")),
  });
  await using screen = await render(element(), bare);
  await expect.element(screen.getByText(/brings back the changes saved on/)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Restore" }).click();
  await expect.element(screen.getByText("The saved changes conflict.")).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
});

it("refetches the status when a turn changes", async () => {
  setup({ state: "cleaned", snapshot: null });
  await using screen = await render(element("run-1:false"), bare);
  expect(state.refresh).not.toHaveBeenCalled();
  await screen.rerender(element("run-1:true"));
  expect(state.refresh).toHaveBeenCalledOnce();
});
