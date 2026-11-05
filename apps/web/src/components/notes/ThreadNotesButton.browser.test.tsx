import { EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadNotesButton } from "./ThreadNotesButton";

const environmentId = EnvironmentId.make("env");
const { commands, note } = vi.hoisted(() => ({
  commands: { calls: [] as Array<{ input: Record<string, unknown> }> },
  note: (path: string, project?: string) => ({
    path,
    title: path.replace(/\.md$/u, ""),
    preview: "",
    related: [],
    pinned: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(project ? { project } : {}),
  }),
}));

vi.mock("../../state/notes", async (importOriginal) => {
  const allowed = Atom.make(true);
  const notes = [
    note("Untitled.md"),
    note("Alpha plan.md", "alpha"),
    note("Beta plan.md", "beta"),
    note("org alpha/Untitled.md", "alpha"),
  ];
  return {
    ...(await importOriginal<object>()),
    useNotesEnvironmentIds: () => ["env"],
    notesEnvironment: {
      live: () =>
        Atom.make(
          AsyncResult.success({
            notes: new Map(notes.map((entry) => [entry.path, entry])),
            truncated: false,
            omitted: 0,
            skipped: [],
          }),
        ),
      write: { permissionAtom: () => allowed },
      update: { permissionAtom: () => allowed },
    },
  };
});
vi.mock("./useNoteCommand", () => ({
  useNoteCommand: () => async (call: { input: Record<string, unknown> }) => {
    commands.calls.push(call);
    return { ok: true, value: { path: call.input.path } };
  },
}));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => [
    { environmentId: "env", id: "alpha", title: "org/alpha", workspaceRoot: "/a" },
    { environmentId: "env", id: "beta", title: "beta", workspaceRoot: "/b" },
  ],
}));

const openButton = (projectId: string | null) =>
  render(
    <ThreadNotesButton
      environmentId={environmentId}
      threadId={"t1" as ThreadId}
      isServerThread
      projectId={projectId as ProjectId | null}
    />,
  );

it("offers only the project's notes and numbers its new note inside the project's folder", async () => {
  commands.calls.length = 0;
  await using _screen = await openButton("beta");
  await userEvent.click(page.getByRole("button", { name: "Notes for this thread" }));
  const offered = page.getByRole("list", { name: "Notes to link" }).getByRole("button");
  await expect.element(offered).toHaveLength(1);
  await expect.element(offered.first()).toHaveTextContent("Beta plan");
  await userEvent.click(page.getByRole("button", { name: "New note for this thread" }));
  await vi.waitFor(() =>
    expect(commands.calls[0]?.input).toMatchObject({ path: "beta/Untitled.md", project: "beta" }),
  );
});

it("steps past a project's own Untitled note, and keeps unscoped notes to threads without a project", async () => {
  commands.calls.length = 0;
  {
    await using _screen = await openButton("alpha");
    await userEvent.click(page.getByRole("button", { name: "Notes for this thread" }));
    await userEvent.click(page.getByRole("button", { name: "New note for this thread" }));
    await vi.waitFor(() =>
      expect(commands.calls[0]?.input).toMatchObject({ path: "org alpha/Untitled 2.md" }),
    );
  }
  await using _screen = await openButton(null);
  await userEvent.click(page.getByRole("button", { name: "Notes for this thread" }));
  const offered = page.getByRole("list", { name: "Notes to link" }).getByRole("button");
  await expect.element(offered).toHaveLength(1);
  await expect.element(offered.first()).toHaveTextContent("Untitled");
});
