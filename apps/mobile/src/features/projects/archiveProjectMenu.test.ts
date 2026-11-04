import { describe, expect, it } from "vite-plus/test";

import { ARCHIVE_PROJECT_ACTION_ID, archiveProjectMenuActions } from "./archiveProjectMenu";

describe("archiveProjectMenuActions", () => {
  it("offers Archive project for the selected project only", () => {
    expect(archiveProjectMenuActions({ label: "Alpha" })).toEqual([
      { id: ARCHIVE_PROJECT_ACTION_ID, title: "Archive project", subtitle: "Alpha" },
    ]);
    expect(archiveProjectMenuActions(undefined)).toEqual([]);
  });
});
