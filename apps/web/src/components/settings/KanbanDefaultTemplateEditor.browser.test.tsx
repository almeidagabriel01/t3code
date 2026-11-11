import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TemplateDialog } from "./KanbanDefaultTemplateEditor";

it.each([
  { icon: "bug", shown: "bug" },
  // Saved before the icon list changed, or set by an agent through the kanban tools.
  { icon: "rocket", shown: "rocket" },
])("the icon field shows a template's $icon icon", async ({ icon, shown }) => {
  await using _screen = await render(
    <TemplateDialog
      template={{
        name: "Feature",
        icon,
        color: "blue",
        priority: "medium",
        checklist: [],
        acceptanceCriteria: [],
      }}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await expect.element(page.getByRole("combobox", { name: "Icon" })).toHaveTextContent(shown);
});
