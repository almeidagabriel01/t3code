import { EnvironmentId, type NoteDocument, type NoteSummary } from "@t3tools/contracts";
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
  canWrite: true,
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
  const denied = Atom.make(false);
  const command = () => ({ permissionAtom: () => allowed });
  return {
    ...(await importOriginal<object>()),
    notesEnvironment: {
      note: ({ input }: { input: { path: string } }) => input.path,
      write: { permissionAtom: () => (mocks.canWrite ? allowed : denied) },
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

  // Leaving for the path our own rename moved to is not leaving the note.
  await screen.router!.navigate({ to: "/", search: { path: "My plan.md" } });
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

it("opens another note when the selected path changes, and tracks the listed summary", async () => {
  mocks.docs.clear();
  mocks.docs.set("A.md", document("A.md", "alpha body", "A", "a"));
  mocks.docs.set("B.md", document("B.md", "bravo body", "B", "b"));
  function Switch() {
    const [path, setPath] = useState("A.md");
    return (
      <>
        <button onClick={() => setPath("B.md")}>Open B</button>
        <NoteLoader
          environmentId={environmentId}
          path={path}
          summary={mocks.docs.get(path) as NoteSummary}
          listReady
          autoFocus={false}
          onSelect={() => undefined}
          onExitEditor={() => undefined}
        />
      </>
    );
  }
  await using _screen = await render(<Switch />);
  const body = page.getByRole("textbox", { name: "Note body" });
  await expect.element(body).toHaveTextContent("alpha body");
  await userEvent.click(page.getByRole("button", { name: "Open B" }));
  await expect.element(body).toHaveTextContent("bravo body");
});

async function openTitled(body = "# Plan\ntext", path = "Plan.md", canWrite = true) {
  mocks.canWrite = canWrite;
  mocks.docs.clear();
  mocks.docs.set(path, document(path, body, "Plan", "a"));
  mocks.write
    .mockReset()
    .mockImplementation(async ({ input }: { input: { body: string; path: string } }) => ({
      ok: true,
      value: document(input.path, input.body, input.body.split("\n")[0]!.replace(/^# /u, ""), "b"),
    }));
  mocks.move.mockReset().mockImplementation(async ({ input }: { input: { to: string } }) => ({
    ok: true,
    value: document(input.to, "# Roadmap\ntext", "Roadmap", "c"),
  }));
  const onSelect = vi.fn();
  const screen = await render(
    <NoteLoader
      environmentId={environmentId}
      path={path}
      summary={undefined}
      listReady={false}
      autoFocus={false}
      onSelect={onSelect}
      onExitEditor={() => undefined}
    />,
  );
  return { onSelect, screen };
}

it("renames from the header: the first line takes the title and the file that carried the old one follows", async () => {
  const { onSelect, screen } = await openTitled();
  await using _screen = screen;
  await userEvent.click(page.getByRole("button", { name: "Rename Plan" }));
  const input = page.getByRole("textbox", { name: "Note title" });
  await userEvent.fill(input, "Roadmap");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ path: "Plan.md", body: "# Roadmap\ntext" }),
    }),
  );
  await vi.waitFor(() =>
    expect(mocks.move).toHaveBeenCalledWith({
      environmentId,
      input: { from: "Plan.md", to: "Roadmap.md", baseRevision: revision("b") },
    }),
  );
  await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith("Roadmap.md", { replace: true }));
});

it("keeps a hand-named file's name when the title changes, and opens with F2", async () => {
  const { screen } = await openTitled("# Plan\ntext", "mine.md");
  await using _screen = screen;
  const button = page.getByRole("button", { name: "Rename Plan" });
  button.element().focus();
  await userEvent.keyboard("{F2}");
  await userEvent.fill(page.getByRole("textbox", { name: "Note title" }), "Roadmap");
  await page.getByRole("button", { name: "Back to notes" }).element().focus();
  await vi.waitFor(() => expect(mocks.write).toHaveBeenCalled());
  expect(mocks.move).not.toHaveBeenCalled();
});

it("Escape, an empty title and an unchanged title leave the note alone", async () => {
  const { screen } = await openTitled();
  await using _screen = screen;
  for (const [text, key] of [
    ["Other", "{Escape}"],
    ["  ", "{Enter}"],
    ["Plan", "{Enter}"],
  ] as const) {
    await userEvent.click(page.getByRole("button", { name: "Rename Plan" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Note title" }), text);
    await userEvent.keyboard(key);
    await expect.element(page.getByRole("button", { name: "Rename Plan" })).toBeVisible();
  }
  expect(mocks.write).not.toHaveBeenCalled();
});

it("shows a plain title when the connection cannot write", async () => {
  const { screen } = await openTitled("# Plan\ntext", "Plan.md", false);
  await using _screen = screen;
  await expect.element(page.getByRole("heading", { name: "Plan" })).toBeVisible();
  expect(page.getByRole("button", { name: "Rename Plan" }).elements()).toHaveLength(0);
});
