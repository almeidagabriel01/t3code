import { EnvironmentId, ThreadId, type ThreadWorkspaceStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  data: null as ThreadWorkspaceStatus | null,
  queried: false,
  worktreePath: "/worktrees/project/feat" as string | null,
  refresh: vi.fn(),
  command: vi.fn(),
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => {
    state.queried = atom !== null;
    return { data: atom === null ? null : state.data, refresh: state.refresh };
  }) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      threadWorkspaceStatus: (() => "status") as never,
      restoreThreadWorkspace: {
        ...actual.serverEnvironment.restoreThreadWorkspace,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.command) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => ({ worktreePath: state.worktreePath })) as never,
}));

import { ThreadWorkspaceCleanedGate, ThreadWorkspaceCleanedRow } from "./ThreadWorkspaceCleaned";
import { useThreadWorkspaceRestore } from "./useThreadWorkspaceRestore";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
// These pieces need no routes; mounting them bare keeps the test on their own behavior.
const bare = { router: false } as const;

function setup(
  data: ThreadWorkspaceStatus | null,
  worktreePath: string | null = "/worktrees/project/feat",
) {
  state.data = data;
  state.queried = false;
  state.worktreePath = worktreePath;
  state.refresh.mockReset();
  state.command.mockReset();
}

function Row() {
  const workspace = useThreadWorkspaceRestore({ ...threadRef, worktreePath: state.worktreePath });
  return <ThreadWorkspaceCleanedRow workspace={workspace} />;
}

const gate = (cwd: string | undefined) => (
  <ThreadWorkspaceCleanedGate threadRef={threadRef} cwd={cwd}>
    <p>Initialize Git</p>
  </ThreadWorkspaceCleanedGate>
);

it("offers Restore in the details panel row and rereads git after restoring", async () => {
  setup({ state: "cleaned", snapshot: null });
  state.command.mockResolvedValue({ _tag: "Success" });
  await using screen = await render(<Row />, bare);
  await expect.element(screen.getByText(/worktree was cleaned up/)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Restore" }).click();
  expect(state.command).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { threadId: "thread-1" },
  });
  expect(state.command).toHaveBeenCalledWith({
    environmentId: "env-1",
    input: { cwd: "/worktrees/project/feat" },
  });
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("renders no row while the worktree is ready", async () => {
  setup({ state: "ready", snapshot: null });
  await using screen = await render(<Row />, bare);
  await expect.element(screen.getByRole("button", { name: "Restore" })).not.toBeInTheDocument();
});

it("replaces a surface that reads the cleaned worktree with the Restore state", async () => {
  setup({ state: "cleaned", snapshot: { capturedAt: "2026-11-01T12:00:00.000Z" } });
  await using screen = await render(gate("/worktrees/project/feat"), bare);
  await expect.element(screen.getByText(/brings back the changes saved on/)).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  await expect.element(screen.getByText("Initialize Git")).not.toBeInTheDocument();
});

it.each([
  ["another folder", "/host/folder", "/worktrees/project/feat"],
  ["a thread on the project folder", "/project", null],
] as const)("leaves a surface on %s alone", async (_name, cwd, worktreePath) => {
  setup({ state: "cleaned", snapshot: null }, worktreePath);
  await using screen = await render(gate(cwd), bare);
  await expect.element(screen.getByText("Initialize Git")).toBeInTheDocument();
  expect(state.queried).toBe(false);
});
