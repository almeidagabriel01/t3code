import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

const base = {
  environments: [],
  projects: [{ key: "p", label: "Alpha" }],
  selectedEnvironmentId: null as EnvironmentId | null,
  onEnvironmentChange: () => undefined,
  onProjectChange: () => undefined,
};

describe("buildHomeListFilterMenuItems archive action", () => {
  it("adds Archive project only for a selected project that can be archived", () => {
    const onArchiveProject = vi.fn();
    const titles = (
      selectedProjectKey: string | null,
      archive: typeof onArchiveProject | undefined,
    ) =>
      buildHomeListFilterMenuItems({ ...base, selectedProjectKey, onArchiveProject: archive }).map(
        (item) => item.title,
      );
    expect(titles("p", onArchiveProject)).toEqual(["Environment", "Project", "Archive project"]);
    expect(titles(null, onArchiveProject)).toEqual(["Environment", "Project"]);
    expect(titles("p", undefined)).toEqual(["Environment", "Project"]);

    const items = buildHomeListFilterMenuItems({
      ...base,
      selectedProjectKey: "p",
      onArchiveProject,
    });
    const action = items.at(-1);
    if (!action || !("onPress" in action)) throw new Error("expected an action");
    action.onPress();
    expect(onArchiveProject).toHaveBeenCalledOnce();
  });
});
