import type { Assistant, AssistantTeam } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantGroupInfoSummary,
  assistantGroupMembers,
  assistantInfoGroups,
  assistantInfoProjects,
} from "./assistantInfo.ts";

const names: Record<string, string> = { web: "Web", api: "API", docs: "Docs" };
const nameOf = (id: string) => names[id] ?? "Project";
const assistant = (scope: "all" | "projects", projectIds: string[]) =>
  ({ id: "ada", scope, projectId: projectIds[0] ?? "home", projectIds }) as unknown as Assistant;

describe("assistantInfoProjects", () => {
  it.each([
    {
      name: "all projects lists only where it works now",
      assistant: assistant("all", []),
      working: ["api", "api"],
      expected: { all: true, rows: ["API*"] },
    },
    {
      name: "all projects and idle has no rows",
      assistant: assistant("all", []),
      working: [],
      expected: { all: true, rows: [] },
    },
    {
      name: "listed projects mark the busy ones",
      assistant: assistant("projects", ["web", "docs"]),
      working: ["docs"],
      expected: { all: false, rows: ["Web", "Docs*"] },
    },
  ])("$name", ({ assistant, working, expected }) => {
    const projects = assistantInfoProjects(
      assistant,
      working.map((projectId) => ({ projectId })),
      nameOf,
    );
    expect({
      all: projects.all,
      rows: projects.rows.map((row) => `${row.name}${row.workingNow ? "*" : ""}`),
    }).toEqual(expected);
  });
});

const team = (id: string, memberIds: string[], leadId: string | null) => ({
  team: { id, memberIds, leadId } as unknown as AssistantTeam,
});

describe("group rows", () => {
  it("lists the groups an assistant is in, marking where it leads", () => {
    const groups = assistantInfoGroups(
      [team("a", ["ada", "bo"], "ada"), team("b", ["bo"], "bo"), team("c", ["ada"], null)],
      "ada",
    );
    expect(groups.map((row) => `${row.entry.team.id}:${row.lead}`)).toEqual(["a:true", "c:false"]);
  });

  it("keeps removed members, lead first, so the count matches the rows", () => {
    const rows = assistantGroupMembers(team("g", ["ada", "gone", "bo"], "bo").team, [
      { id: "ada" },
      { id: "bo" },
    ]);
    expect(rows.map((row) => `${row.id}:${row.assistant?.id ?? "none"}:${row.lead}`)).toEqual([
      "bo:bo:true",
      "ada:ada:false",
      "gone:none:false",
    ]);
    expect(assistantGroupInfoSummary(rows.length, 2)).toBe("3 members · 2 running");
  });
});
