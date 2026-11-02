import { EnvironmentId, type NoteDocument } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NoteLoader } from "./NoteDetail";

const mocks = vi.hoisted(() => ({
  docs: new Map<string, unknown>(),
  write: vi.fn(),
  move: vi.fn(),
}));

vi.mock("./useNoteCommand", async () => {
  const { notesEnvironment } = await import("../../state/notes");
  return {
    useNoteCommand: (command: unknown) =>
      command === notesEnvironment.write
        ? mocks.write
        : command === notesEnvironment.move
          ? mocks.move
          : vi.fn(),
  };
});
vi.mock("../../state/notes", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = () => ({ permissionAtom: () => allowed });
  return {
    ...(await importOriginal<object>()),
    notesEnvironment: {
      note: ({ input }: { input: { path: string } }) => input.path,
      write: command(),
      move: command(),
      read: command(),
      update: command(),
      delete: command(),
      startWork: command(),
    },
  };
});
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentQuery: (path: string) => ({
    data: mocks.docs.get(path) ?? null,
    error: null,
    refresh: () => undefined,
  }),
}));
vi.mock("../../state/kanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanEnvironmentIds: () => [],
}));

const environmentId = EnvironmentId.make("env");
const revision = (char: string) => char.repeat(64);

const document = (path: string, body: string, title: string, rev: string): NoteDocument =>
  ({
    id: null,
    path,
    folder: null,
    title,
    body,
    pinned: false,
    preview: "",
    related: [],
    card: null,
    updatedBy: "user",
    revision: revision(rev),
    updatedAt: "2026-01-01T00:00:00.000Z",
    size: body.length,
  }) as NoteDocument;

function Host(props: { onPath: (path: string) => void }) {
  const [path, setPath] = useState("Untitled.md");
  return (
    <NoteLoader
      environmentId={environmentId}
      path={path}
      summary={undefined}
      listReady={false}
      autoFocus
      onSelect={(next) => {
        if (next) {
          props.onPath(next);
          setPath(next);
        }
      }}
      onExitEditor={() => undefined}
    />
  );
}

async function openUntitled(taken: ReadonlyArray<string>) {
  mocks.docs.clear();
  mocks.docs.set("Untitled.md", document("Untitled.md", "", "Untitled", "a"));
  let saved = "";
  mocks.write
    .mockReset()
    .mockImplementation(async ({ input }: { input: { body: string; path: string } }) => {
      saved = input.body;
      return {
        ok: true,
        value: document(
          input.path,
          saved,
          "My plan",
          "bde"[Math.min(mocks.write.mock.calls.length, 3) - 1]!,
        ),
      };
    });
  mocks.move.mockReset().mockImplementation(async ({ input }: { input: { to: string } }) => {
    if (taken.includes(input.to)) return { ok: false, error: { reason: "exists" } };
    const moved = document(input.to, saved, "My plan", "c");
    mocks.docs.set(input.to, moved);
    return { ok: true, value: moved };
  });
  const onPath = vi.fn();
  return { onPath, screen: await render(<Host onPath={onPath} />) };
}

it("renames an untitled note to its title and keeps the editor, focus and typing", async () => {
  const { onPath, screen } = await openUntitled([]);
  await using _screen = screen;
  const body = page.getByRole("textbox", { name: "Note body" });
  await expect.element(body).toHaveFocus();
  const editor = body.element();

  await userEvent.keyboard("# My plan");
  await vi.waitFor(() =>
    expect(mocks.move).toHaveBeenCalledWith({
      environmentId,
      input: { from: "Untitled.md", to: "My plan.md", baseRevision: revision("b") },
    }),
  );
  await vi.waitFor(() => expect(onPath).toHaveBeenCalledWith("My plan.md"));

  await userEvent.keyboard(" now");
  expect(body.element()).toBe(editor);
  await expect.element(body).toHaveFocus();
  await expect.element(body).toHaveTextContent("My plan now");
  // The edit typed after the rename saves to the new path, never back to the old one.
  await vi.waitFor(() =>
    expect(mocks.write).toHaveBeenLastCalledWith({
      environmentId,
      input: expect.objectContaining({ path: "My plan.md", body: expect.stringContaining("now") }),
    }),
  );
  expect(mocks.move).toHaveBeenCalledTimes(1);
});

it("steps to the next free name when the title's file already exists", async () => {
  const { onPath, screen } = await openUntitled(["My plan.md"]);
  await using _screen = screen;
  await expect.element(page.getByRole("textbox", { name: "Note body" })).toHaveFocus();
  await userEvent.keyboard("# My plan");
  await vi.waitFor(() => expect(onPath).toHaveBeenCalledWith("My plan 2.md"));
  expect(mocks.move.mock.calls.map(([call]) => call.input.to)).toEqual([
    "My plan.md",
    "My plan 2.md",
  ]);
});
