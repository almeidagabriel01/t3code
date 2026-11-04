import { describe, expect, it, vi } from "vite-plus/test";

import { buildProjectArchiveActionItems } from "./CommandPaletteProjectItems";

describe("buildProjectArchiveActionItems", () => {
  it.each([
    { archived: false, title: "Archive project" },
    { archived: true, title: "Unarchive project" },
  ])("titles the command $title and toggles that project", async ({ archived, title }) => {
    const toggle = vi.fn().mockResolvedValue(undefined);
    const group = { archived, displayName: "Alpha" };
    const [item, ...rest] = buildProjectArchiveActionItems(group, () => true, toggle);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ title, description: "Alpha", value: "action:project-archive" });
    await item!.run();
    expect(toggle).toHaveBeenCalledWith(group);
  });

  it.each([
    { name: "no current project", group: null, can: true },
    { name: "read-only or older server", group: { archived: false, displayName: "A" }, can: false },
  ])("offers nothing for $name", ({ group, can }) => {
    expect(buildProjectArchiveActionItems(group, () => can, vi.fn())).toEqual([]);
  });
});
