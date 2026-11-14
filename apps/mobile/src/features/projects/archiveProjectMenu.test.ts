import { describe, expect, it, vi } from "vite-plus/test";

import {
  ARCHIVE_PROJECT_ACTION_ID,
  PROJECT_SETTINGS_ACTION_ID,
  runSelectedProjectAction,
  selectedProjectMenuActions,
} from "./archiveProjectMenu";

describe("selectedProjectMenuActions", () => {
  it("offers each selected-project entry only when it can run from here", () => {
    const archive = vi.fn();
    const openSettings = vi.fn();
    expect(selectedProjectMenuActions({ label: "Alpha" }, { archive, openSettings })).toEqual([
      {
        id: PROJECT_SETTINGS_ACTION_ID,
        title: "Project settings",
        subtitle: "Alpha",
        image: "gearshape",
      },
      {
        id: ARCHIVE_PROJECT_ACTION_ID,
        title: "Archive project",
        subtitle: "Alpha",
        image: "archivebox",
      },
    ]);
    expect(selectedProjectMenuActions(undefined, { archive, openSettings })).toEqual([]);
    expect(selectedProjectMenuActions({ label: "Alpha" }, { archive }).map((a) => a.id)).toEqual([
      ARCHIVE_PROJECT_ACTION_ID,
    ]);
    expect(selectedProjectMenuActions({ label: "Alpha" }, {})).toEqual([]);
  });
});

describe("runSelectedProjectAction", () => {
  it("runs the selected project's entries and leaves other ids alone", () => {
    const archive = vi.fn();
    const openSettings = vi.fn();
    expect(runSelectedProjectAction("environment:all", { archive, openSettings })).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(runSelectedProjectAction(ARCHIVE_PROJECT_ACTION_ID, { archive, openSettings })).toBe(
      true,
    );
    expect(archive).toHaveBeenCalledOnce();
    expect(runSelectedProjectAction(PROJECT_SETTINGS_ACTION_ID, { archive, openSettings })).toBe(
      true,
    );
    expect(openSettings).toHaveBeenCalledOnce();
    expect(runSelectedProjectAction(ARCHIVE_PROJECT_ACTION_ID, {})).toBe(true);
  });
});
