import { describe, expect, it, vi } from "vite-plus/test";

import {
  ARCHIVE_PROJECT_ACTION_ID,
  archiveProjectMenuActions,
  runArchiveProjectAction,
} from "./archiveProjectMenu";

describe("archiveProjectMenuActions", () => {
  it("offers Archive project only for a selected project that can be archived", () => {
    const archive = vi.fn();
    expect(archiveProjectMenuActions({ label: "Alpha" }, archive)).toEqual([
      { id: ARCHIVE_PROJECT_ACTION_ID, title: "Archive project", subtitle: "Alpha" },
    ]);
    expect(archiveProjectMenuActions(undefined, archive)).toEqual([]);
    expect(archiveProjectMenuActions({ label: "Alpha" }, undefined)).toEqual([]);
  });
});

describe("runArchiveProjectAction", () => {
  it("runs the archive entry and leaves other ids alone", () => {
    const archive = vi.fn();
    expect(runArchiveProjectAction("environment:all", archive)).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(runArchiveProjectAction(ARCHIVE_PROJECT_ACTION_ID, archive)).toBe(true);
    expect(archive).toHaveBeenCalledOnce();
    expect(runArchiveProjectAction(ARCHIVE_PROJECT_ACTION_ID, undefined)).toBe(true);
  });
});
