import { EnvironmentId, ProjectId, ThreadId, type ThreadWorkspaceStatus } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ status: null as ThreadWorkspaceStatus | null }));

vi.mock("./useThreadWorkspaceRestore", () => ({
  useThreadWorkspaceRestore: () => ({ status: state.status }),
}));
vi.mock("./ThreadWorkspaceCleaned", () => ({
  ThreadWorkspaceCleanedRow: () => <p>Restore row</p>,
}));
vi.mock("../GitActionsControl", () => ({
  default: (props: { allowInitialize?: boolean }) => (
    <p>{`Git rows, initialize ${props.allowInitialize}`}</p>
  ),
}));
vi.mock("../BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: (props: { children: (density: "full") => ReactNode }) => (
    <div>{props.children("full")}</div>
  ),
}));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({ useT3ProjectFileScripts: () => [] }));
vi.mock("./ThreadServersPanel", () => ({ ThreadServersPanel: () => null }));
vi.mock("./ThreadAutomationsPanel", () => ({ ThreadAutomationsPanel: () => null }));
vi.mock("./ThreadRelationshipsControl", () => ({ ThreadRelationshipsPanel: () => null }));
vi.mock("./ThreadDetailsItemsMenu", () => ({ ThreadDetailsItemsMenuItems: () => null }));
vi.mock("./ThreadDetailsUsage", () => ({
  ThreadDetailsContext: () => null,
  ThreadDetailsUsage: () => null,
}));

import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const bare = { router: false } as const;

function panel(worktreePath: string | null, draftId?: string) {
  return (
    <ThreadDetailsPanel
      anchor={undefined as never}
      handle={undefined as never}
      environmentId={EnvironmentId.make("env-1")}
      threadId={ThreadId.make("thread-1")}
      projectId={ProjectId.make("project-1")}
      worktreePath={worktreePath}
      isServerThread
      {...(draftId ? { draftId: draftId as never } : {})}
      activeProjectName="Project"
      activeProjectScripts={undefined}
      preferredScriptId={null}
      keybindings={[]}
      availableEditors={[]}
      showOpenInPicker={false}
      openInShortcutEnabled={false}
      gitCwd="/work/project"
      isGitRepo
      envLocked={false}
      availableEnvironments={[]}
      onEnvModeChange={() => {}}
      envMode="local"
      startFromOrigin={false}
      onStartFromOriginChange={() => {}}
      onComposerFocusRequest={() => {}}
      onRunProjectScript={() => {}}
      onAddProjectScript={async () => ({ ok: true }) as never}
      onUpdateProjectScript={async () => ({ ok: true }) as never}
      onDeleteProjectScript={async () => ({ ok: true }) as never}
      usage={{} as never}
    />
  );
}

it("offers Restore instead of the git rows for a cleaned worktree", async () => {
  state.status = { state: "cleaned", snapshot: null };
  await using screen = await render(panel("/worktrees/p/feat"), bare);
  await expect.element(screen.getByText("Restore row")).toBeInTheDocument();
  await expect.element(screen.getByText(/Git rows/)).not.toBeInTheDocument();
});

it.each([
  ["a ready worktree", { state: "ready", snapshot: null } as const, "/worktrees/p/feat", "false"],
  ["a thread on the project folder", null, null, "true"],
] as const)(
  "keeps the git rows for %s and initializes only outside a worktree",
  async (_name, status, worktreePath, initialize) => {
    state.status = status;
    await using screen = await render(panel(worktreePath), bare);
    await expect
      .element(screen.getByText(`Git rows, initialize ${initialize}`))
      .toBeInTheDocument();
    await expect.element(screen.getByText("Restore row")).not.toBeInTheDocument();
  },
);
