import type { KanbanBoardState } from "@t3tools/client-runtime/state/kanban";
import { EnvironmentId, type KanbanCard, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { KanbanStartAgentDialog } from "./KanbanStartAgent";

const mocks = vi.hoisted(() => ({ project: null as unknown }));

vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProject: () => mocks.project,
}));

const board = {
  id: "b1",
  projectId: "p1" as ProjectId,
  cards: new Map(),
} as unknown as KanbanBoardState;
const card = { id: "c1", number: 4, title: "Renew domain", parentCardId: null } as KanbanCard;

function open(project: { isScratch?: true }) {
  mocks.project = { id: "p1", workspaceRoot: "/work/p1", title: "P", ...project };
  return render(
    <KanbanStartAgentDialog
      environmentId={EnvironmentId.make("env")}
      board={board}
      cards={[card]}
      onClose={vi.fn()}
    />,
  );
}

describe("KanbanStartAgentDialog", () => {
  it("offers a new worktree for a repository project", async () => {
    await using _screen = await open({});
    await expect.element(page.getByText("New worktree")).toBeInTheDocument();
  });

  it("hides the worktree for the No-project board, whose folder is not a repository", async () => {
    await using _screen = await open({ isScratch: true });
    await expect.element(page.getByText("Permissions")).toBeInTheDocument();
    await expect.element(page.getByText("New worktree")).not.toBeInTheDocument();
  });
});
