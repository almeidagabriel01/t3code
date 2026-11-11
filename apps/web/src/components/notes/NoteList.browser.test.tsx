import { EnvironmentId, type NoteSummary } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteList } from "./NoteList";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  move: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("./useNoteCommand", async () => {
  const { notesEnvironment } = await import("../../state/notes");
  return {
    useNoteCommand: (command: unknown) =>
      command === notesEnvironment.read
        ? mocks.read
        : command === notesEnvironment.write
          ? mocks.write
          : command === notesEnvironment.move
            ? mocks.move
            : mocks.update,
  };
});
vi.mock("../../state/notes", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = () => ({ permissionAtom: () => allowed });
  return {
    notesEnvironment: {
      update: command(),
      move: command(),
      delete: command(),
      startWork: command(),
      read: command(),
      write: command(),
    },
  };
});
vi.mock("../../state/kanban", () => ({ useKanbanEnvironmentIds: () => [] }));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toastManager: { add: mocks.toast },
}));
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

function list(onSelect: (path: string) => void = () => undefined, selectedPath?: string) {
  return (
    <NoteList
      environmentId={EnvironmentId.make("env")}
      notes={[note]}
      folders={[]}
      selectedPath={selectedPath}
      query=""
      onQueryChange={() => undefined}
      onSelect={onSelect}
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

  it("renames in place: the first line takes the title and the file follows it", async () => {
    mocks.read.mockReset().mockResolvedValue({
      ok: true,
      value: { ...note, title: "plan", body: "# plan\ntext", revision: "r2" },
    });
    mocks.write.mockReset().mockResolvedValue({
      ok: true,
      value: { ...note, path: "plan.md", title: "Roadmap", revision: "r3" },
    });
    mocks.move.mockReset().mockResolvedValue({ ok: true, value: { ...note, path: "Roadmap.md" } });
    const onSelect = vi.fn();
    await using _screen = await render(list(onSelect, "plan.md"), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Actions for Plan" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Rename", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Rename Plan" }), "Roadmap");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("Roadmap.md"));
    expect(mocks.write).toHaveBeenCalledWith({
      environmentId: "env",
      input: { path: "plan.md", body: "# Roadmap\ntext", baseRevision: "r2" },
    });
    expect(mocks.move).toHaveBeenCalledWith({
      environmentId: "env",
      input: { from: "plan.md", to: "Roadmap.md", baseRevision: "r3" },
    });
    await expect.element(page.getByRole("button", { name: "Actions for Plan" })).toBeVisible();
  });

  it("cancels with Escape and offers the file action under its own name", async () => {
    mocks.read.mockReset();
    await using _screen = await render(list(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Actions for Plan" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Move or rename file…" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "Rename", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Rename Plan" }), "Other");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Actions for Plan" })).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ["the read fails", () => mocks.read.mockResolvedValue({ ok: false, error: new Error("gone") })],
    [
      "the note changed underneath",
      () => {
        mocks.read.mockResolvedValue({
          ok: true,
          value: { ...note, body: "Plan", revision: "r2" },
        });
        mocks.write.mockResolvedValue({ ok: false, error: new Error("Changed elsewhere") });
      },
    ],
  ])("reports an error and leaves the file alone when %s", async (_name, arrange) => {
    mocks.read.mockReset();
    mocks.write.mockReset();
    mocks.move.mockReset();
    mocks.toast.mockReset();
    arrange();
    await using _screen = await render(list(), { router: false });
    await userEvent.click(page.getByRole("button", { name: "Actions for Plan" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Rename", exact: true }));
    await userEvent.fill(page.getByRole("textbox", { name: "Rename Plan" }), "Roadmap");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.move).not.toHaveBeenCalled();
  });
});

const notesAt = (newest: string | null) =>
  Array.from({ length: 40 }, (_, index) => ({
    ...note,
    path: `n${index}.md`,
    title: `Note ${index}`,
    updatedAt:
      newest === `n${index}.md`
        ? "2026-02-01T00:00:00.000Z"
        : `2026-01-01T00:${String(59 - index).padStart(2, "0")}:00.000Z`,
  }));

describe("NoteList scroll", () => {
  it("stays where it is when saving moves the note in view to the top", async () => {
    const container = document.createElement("div");
    container.style.cssText = "display:flex;flex-direction:column;height:300px";
    const view = (notes: NoteSummary[]) => (
      <NoteList
        environmentId={EnvironmentId.make("env")}
        notes={notes}
        folders={[]}
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onOpenEditor={() => undefined}
        onCreate={null}
        createShortcut={null}
      />
    );
    await using screen = await render(view(notesAt(null)), { container, router: false });
    const row = page.getByRole("button", { name: /^Note 15\b/ });
    await expect.element(row).toBeInTheDocument();
    let scroller = row.element().parentElement!;
    while (getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement!;
    scroller.scrollTop +=
      row.element().getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const before = scroller.scrollTop;
    await screen.rerender(view(notesAt("n15.md")));
    expect(scroller.scrollTop).toBe(before);
  });
});
