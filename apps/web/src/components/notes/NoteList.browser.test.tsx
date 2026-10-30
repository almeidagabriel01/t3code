import { EnvironmentId, type NoteSummary } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteList } from "./NoteList";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("./useNoteCommand", () => ({ useNoteCommand: () => mocks.update }));
vi.mock("../../state/notes", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = { permissionAtom: () => allowed };
  return {
    notesEnvironment: { update: command, move: command, delete: command, startWork: command },
  };
});
vi.mock("../../state/kanban", () => ({ useKanbanEnvironmentIds: () => [] }));
vi.mock("./NoteStartWorkDialog", () => ({ NoteStartWorkDialog: () => null }));
vi.mock("./NoteFileDialog", () => ({
  NoteFileDialog: (props: { action: string; document: { path: string } }) => (
    <p role="dialog">{`${props.action} ${props.document.path}`}</p>
  ),
}));

const note = {
  id: null,
  path: "plan.md",
  folder: null,
  title: "Plan",
  pinned: false,
  preview: "",
  related: [],
  card: null,
  updatedBy: null,
  revision: "r1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  size: 1,
} as unknown as NoteSummary;

function list() {
  return (
    <NoteList
      environmentId={EnvironmentId.make("env")}
      notes={[note]}
      folders={[]}
      selectedPath={undefined}
      query=""
      onQueryChange={() => undefined}
      onSelect={() => undefined}
      onOpenEditor={() => undefined}
      onCreate={null}
      createShortcut={null}
    />
  );
}

describe("NoteList row menu", () => {
  it("pins and opens the delete dialog without opening the note", async () => {
    mocks.update.mockReset().mockResolvedValue({ ok: true, value: note });
    await using _screen = await render(list(), { router: false });
    const trigger = page.getByRole("button", { name: "Actions for Plan" });
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Pin to the top" }));
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId: "env",
      input: { path: "plan.md", pinned: true },
    });
    await userEvent.click(trigger);
    await userEvent.click(page.getByRole("menuitem", { name: "Delete…" }));
    await expect.element(page.getByRole("dialog")).toHaveTextContent("delete plan.md");
  });
});
