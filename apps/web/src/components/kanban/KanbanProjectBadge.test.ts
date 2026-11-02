import { describe, expect, it } from "vite-plus/test";

import { kanbanProjectName } from "./KanbanProjectBadge";

describe("kanbanProjectName", () => {
  const scratch = { displayName: "No project", isScratch: true as const };
  const members = [{}, {}];

  it("tells the No-project boards of several environments apart", () => {
    expect(
      kanbanProjectName({ ...scratch, memberProjects: members }, { environmentLabel: "Mac" }),
    ).toBe("No project · Mac");
  });

  it("keeps the plain name for one environment, an unnamed one, or an ordinary project", () => {
    expect(
      kanbanProjectName({ ...scratch, memberProjects: [{}] }, { environmentLabel: "Mac" }),
    ).toBe("No project");
    expect(
      kanbanProjectName({ ...scratch, memberProjects: members }, { environmentLabel: null }),
    ).toBe("No project");
    expect(
      kanbanProjectName(
        { displayName: "Alpha", memberProjects: members },
        { environmentLabel: "Mac" },
      ),
    ).toBe("Alpha");
  });
});
