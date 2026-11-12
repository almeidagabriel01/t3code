import { describe, expect, it } from "vite-plus/test";

import { projectViewCommands, projectViewsFor } from "./projectViews";

describe("projectViewCommands", () => {
  it("names one command per offered section, each findable by project", () => {
    const commands = projectViewCommands(projectViewsFor(false), "Alpha");
    expect(commands.map((command) => [command.view, command.key, command.title])).toEqual([
      ["scheduled", "projectScheduledTasks", "Scheduled tasks in Alpha"],
      ["activity", "projectActivity", "Activity in Alpha"],
      ["memory", "projectMemory", "Memory for Alpha"],
      ["heavy-work", "projectHeavyWork", "Heavy work in Alpha"],
    ]);
    expect(projectViewCommands(projectViewsFor(true), "Alpha")[0]).toMatchObject({
      key: "projectBoard",
      title: "Board for Alpha",
    });
    expect(commands.every((command) => command.searchTerms.includes("project"))).toBe(true);
  });
});
