import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

const base = {
  environments: [],
  projects: [{ key: "p", label: "Alpha" }],
  selectedEnvironmentId: null as EnvironmentId | null,
  onEnvironmentChange: () => undefined,
  onProjectChange: () => undefined,
};

describe("buildHomeListFilterMenu archive action", () => {
  it("adds Archive project only for a selected project that can be archived", () => {
    const onArchiveProject = vi.fn();
    const titles = (
      selectedProjectKey: string | null,
      archive: typeof onArchiveProject | undefined,
    ) =>
      buildHomeListFilterMenu({ ...base, selectedProjectKey, onArchiveProject: archive }).items.map(
        (item) => item.title,
      );
    expect(titles("p", onArchiveProject)).toEqual(["Environment", "Project", "Archive project"]);
    expect(titles(null, onArchiveProject)).toEqual(["Environment", "Project"]);
    expect(titles("p", undefined)).toEqual(["Environment", "Project"]);

    const menu = buildHomeListFilterMenu({
      ...base,
      selectedProjectKey: "p",
      onArchiveProject,
    });
    const action = menu.items.at(-1);
    if (action?.type !== "action") throw new Error("expected an action");
    action.onPress();
    expect(onArchiveProject).toHaveBeenCalledOnce();
  });
});
