import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { navigate },
  whenRootNavigationReady: (run: () => void) => run(),
}));

import { projectViewPaletteActions } from "./openProjectView";
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

describe("projectViewPaletteActions", () => {
  it("opens the thread's project sheet on the chosen section", () => {
    const thread = { environmentId: "env" as EnvironmentId, id: "t1" as ThreadId };
    const project = { environmentId: "env" as EnvironmentId, title: "Alpha" };
    expect(projectViewPaletteActions(thread, project, [])).toHaveLength(4);
    const actions = projectViewPaletteActions(thread, project, [project.environmentId]);
    expect(actions.map((action) => action.kind)).toEqual(Array(5).fill("action"));
    actions.find((action) => action.view === "memory")!.run();
    expect(navigate).toHaveBeenCalledWith("ThreadProjectView", {
      environmentId: "env",
      threadId: "t1",
      view: "memory",
    });
  });
});
