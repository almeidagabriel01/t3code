import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { ProjectMultiPicker } from "./ProjectMultiPicker";

const project = (id: string, title: string, extra: object = {}) => ({
  environmentId: "env",
  id,
  title,
  workspaceRoot: `/work/${id}`,
  ...extra,
});

const state = vi.hoisted(() => ({ projects: [] as ReadonlyArray<object> }));
vi.mock("../../state/entities", () => ({ useProjects: () => state.projects }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

describe("ProjectMultiPicker", () => {
  it("filters by title without case or accents, and says when nothing matches", async () => {
    state.projects = [project("p1", "Café Site"), project("p2", "Billing")];
    await using _screen = await render(
      <ProjectMultiPicker environmentId={"env" as never} selected={[]} onChange={vi.fn()} />,
    );
    await userEvent.fill(page.getByLabelText("Search projects"), "cafe");
    await expect.element(page.getByRole("checkbox", { name: "Café Site" })).toBeVisible();
    expect(page.getByRole("checkbox", { name: "Billing" }).query()).toBeNull();
    await userEvent.fill(page.getByLabelText("Search projects"), "zzz");
    await expect.element(page.getByText("No projects match")).toBeVisible();
  });

  it("lists archived projects as Archived, skips home projects and reports checks", async () => {
    state.projects = [
      project("p1", "Old", { archivedAt: "2026-01-01T00:00:00.000Z" }),
      project("p2", "Live"),
      project("home", "Assistants", { managedRole: "assistants" }),
      project("other", "Elsewhere", { environmentId: "env-2" }),
    ];
    const onChange = vi.fn();
    await using screen = await render(
      <ProjectMultiPicker
        environmentId={"env" as never}
        selected={["p2" as never]}
        onChange={onChange}
      />,
    );
    await expect.element(page.getByText("Archived")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Assistants");
    expect(screen.container.textContent).not.toContain("Elsewhere");
    await userEvent.click(page.getByRole("checkbox", { name: "Old" }));
    expect(onChange).toHaveBeenCalledWith(["p2", "p1"]);
    await userEvent.click(page.getByRole("checkbox", { name: "Live" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
