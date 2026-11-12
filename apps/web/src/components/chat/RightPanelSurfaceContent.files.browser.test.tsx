import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ navigateFolder: vi.fn() }));

vi.mock("./ThreadWorkspaceCleaned", () => ({
  ThreadWorkspaceCleanedGate: (props: { cwd?: string; children: ReactNode }) => (
    <section aria-label={`Gate cwd ${props.cwd ?? "none"}`}>{props.children}</section>
  ),
}));
vi.mock("../files/FilePreviewPanel", () => ({
  default: (props: {
    onNavigateFolder: (path: string, trail: string[], keep: boolean) => void;
  }) => <button onClick={() => props.onNavigateFolder("src", ["src"], false)}>Open folder</button>,
}));
vi.mock("./SideChatPane", () => ({ default: () => null }));
vi.mock("../PersistentThreadTerminals", () => ({ PersistentThreadTerminalPanel: () => null }));
vi.mock("../pullRequest/PullRequestDetailPanel", () => ({ PullRequestDetailPanel: () => null }));
vi.mock("../pullRequest/PullRequestGhosts", () => ({ PullRequestDetailGhost: () => null }));
vi.mock("../pullRequest/PullRequestsUnavailableState", () => ({
  PullRequestsUnavailableState: () => null,
}));
vi.mock("../pullRequest/ThreadPullRequestsPanel", () => ({ ThreadPullRequestsPanel: () => null }));
vi.mock("../notes/NotesSurface", () => ({ NotesSurface: () => null }));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ navigateFolder: state.navigateFolder }) },
}));

import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

const environmentId = EnvironmentId.make("env-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const bare = { router: false } as const;

function content(surface: unknown) {
  return (
    <RightPanelSurfaceContent
      surface={surface as never}
      activeSurfaceId={null}
      threadRef={threadRef}
      environmentId={environmentId}
      visible
      composerDraftTarget={threadRef}
      keybindings={[]}
      configuredPreviewUrls={[]}
      workspaceMutationId={null}
      getShortcutContext={() => ({}) as never}
      onSendAnnotation={() => {}}
      onCloseSurface={() => {}}
      notes={null}
      project={null}
      terminal={{} as never}
      pullRequest={{} as never}
      files={{
        projectName: "Project",
        workspaceRoot: "/worktrees/p/feat",
        availableEditors: [],
        pendingSurfaceIds: new Set(),
        onOpenFile: () => {},
        onPendingChange: () => {},
      }}
      sideChatParentPanel={"files" as never}
    />
  );
}

it("gates the file explorer on the thread's workspace and routes folder navigation to the panel store", async () => {
  await using screen = await render(content({ id: "files", kind: "files", folderTrail: [] }), bare);
  await expect
    .element(screen.getByRole("region", { name: "Gate cwd /worktrees/p/feat" }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Open folder" }).click();
  expect(state.navigateFolder).toHaveBeenCalledWith(threadRef, "files", "src", ["src"], false);
});

it("does not gate an attachment preview on the workspace", async () => {
  await using screen = await render(
    content({
      id: "attachment:a1",
      kind: "file",
      relativePath: "notes.txt",
      folderTrail: [],
      revealRequestId: 0,
      attachment: { id: "a1", name: "notes.txt" },
    }),
    bare,
  );
  await expect.element(screen.getByRole("region", { name: "Gate cwd none" })).toBeVisible();
});
