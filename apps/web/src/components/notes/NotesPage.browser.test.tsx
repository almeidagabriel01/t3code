import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { NotesPage } from "./NotesPage";

const environmentId = EnvironmentId.make("env");
const project = (id: string, title: string, workspaceRoot: string, env = environmentId) => ({
  environmentId: env,
  id,
  title,
  workspaceRoot,
});

vi.mock("../../state/notes", async (importOriginal) => {
  const allowed = Atom.make(true);
  return {
    ...(await importOriginal<object>()),
    useNotesEnvironmentIds: () => ["env"],
    notesEnvironment: {
      live: () =>
        Atom.make(
          AsyncResult.success({ notes: new Map(), truncated: false, omitted: 0, skipped: [] }),
        ),
      write: { permissionAtom: () => allowed },
    },
  };
});
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => [
    project("p1", "app", "/work/a/app"),
    project("p2", "app", "/work/b/app"),
    project("p3", "Solo", "/work/solo"),
    project("p4", "app", "/work/c/app", EnvironmentId.make("other")),
  ],
}));
vi.mock("../../hooks/useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));
vi.mock("./NoteList", () => ({
  NoteList: (props: { projectNames?: ReadonlyMap<string, string> }) => (
    <ul aria-label="Project names">
      {[...(props.projectNames ?? [])].map(([id, name]) => (
        <li key={id}>{`${id}=${name}`}</li>
      ))}
    </ul>
  ),
}));

it("labels this environment's projects for the note list, telling same-named ones apart", async () => {
  await using _screen = await render(
    <SidebarProvider>
      <NotesPage />
    </SidebarProvider>,
  );
  const names = page.getByRole("list", { name: "Project names" }).getByRole("listitem");
  await expect.element(names).toHaveLength(3);
  await expect.element(names.nth(0)).toHaveTextContent("p1=app · a");
  await expect.element(names.nth(1)).toHaveTextContent("p2=app · b");
  await expect.element(names.nth(2)).toHaveTextContent("p3=Solo");
});
