import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import type { KanbanProjectInfo } from "./KanbanProjectBadge";
import { KanbanPage } from "./KanbanPage";

const environmentId = EnvironmentId.make("env");
const member = (id: string, workspaceRoot: string) => ({
  environmentId,
  id,
  workspaceRoot,
  environmentLabel: null,
  physicalProjectKey: `${environmentId}:${id}`,
});
const group = (
  projectKey: string,
  displayName: string,
  workspaceRoot: string,
  extra: { isScratch?: true } = {},
) => ({
  projectKey,
  displayName,
  workspaceRoot,
  memberProjects: [member(projectKey, workspaceRoot)],
  ...extra,
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../hooks/useSidebarProjectGroups", () => ({
  useSidebarProjectGroups: () => [
    group("a", "app", "/work/a/app"),
    group("b", "app", "/work/b/app"),
    group("s", "Scratch", "/data/scratch", { isScratch: true }),
    group("c", "Solo", "/work/solo"),
  ],
}));
vi.mock("./useKanban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useKanbanStates: () => [{ environmentId, state: { boards: new Map() }, error: null }],
  useKanbanCanEdit: () => false,
  useKanbanActions: () => ({}),
}));
vi.mock("./KanbanGlobalBoard", () => ({
  KanbanGlobalBoard: (props: { projects: ReadonlyMap<string, KanbanProjectInfo> }) => (
    <ul aria-label="Projects">
      {[...props.projects.values()].map((entry) => (
        <li key={entry.projectKey}>{entry.name}</li>
      ))}
    </ul>
  ),
}));

it("tells projects that share a name apart by folder and names the scratch folder", async () => {
  await using _screen = await render(
    <SidebarProvider>
      <KanbanPage />
    </SidebarProvider>,
  );
  const names = page.getByRole("list", { name: "Projects" }).getByRole("listitem");
  await expect.element(names.nth(0)).toHaveTextContent("app · a");
  await expect.element(names.nth(1)).toHaveTextContent("app · b");
  await expect.element(names.nth(2)).toHaveTextContent("Scratch");
  await expect.element(names.nth(3)).toHaveTextContent("Solo");
});
