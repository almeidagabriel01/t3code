import { describe, expect, it, vi } from "vite-plus/test";

import { projectRowMenuItems, showProjectRowMenu } from "./projectRowMenu";

describe("project row menu", () => {
  it.each([
    { archived: false, canArchive: true, labels: ["Project settings", "Archive project"] },
    { archived: true, canArchive: true, labels: ["Project settings", "Unarchive project"] },
    { archived: false, canArchive: false, labels: ["Project settings"] },
  ])("lists $labels", ({ archived, canArchive, labels }) => {
    expect(projectRowMenuItems({ archived, canArchive }).map((item) => item.label)).toEqual(labels);
  });

  it.each([
    { clicked: "project-settings", settings: 1, archive: 0 },
    { clicked: "archive-project", settings: 0, archive: 1 },
    { clicked: null, settings: 0, archive: 0 },
  ] as const)("runs the clicked action: $clicked", async ({ clicked, settings, archive }) => {
    const onSettings = vi.fn();
    const onToggleArchive = vi.fn();
    await showProjectRowMenu({
      show: async () => clicked,
      archived: false,
      canArchive: true,
      position: { x: 1, y: 2 },
      onSettings,
      onToggleArchive,
    });
    expect(onSettings).toHaveBeenCalledTimes(settings);
    expect(onToggleArchive).toHaveBeenCalledTimes(archive);
  });
});
