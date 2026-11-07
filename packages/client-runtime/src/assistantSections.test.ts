import { describe, expect, it } from "vite-plus/test";

import { assistantSections, type SectionAssistant, type SectionTeam } from "./assistantSections.ts";

const a = (id: string, scope: "all" | "project" = "all", projectId = "p1"): SectionAssistant => ({
  environmentId: "env",
  assistant: { id, scope, projectId } as unknown as SectionAssistant["assistant"],
});
const t = (id: string, memberIds: string[]): SectionTeam => ({
  environmentId: "env",
  team: { id, memberIds } as unknown as SectionTeam["team"],
});
const ids = (entries: ReadonlyArray<SectionAssistant>) => entries.map((e) => e.assistant.id);

describe("assistantSections", () => {
  it.each([
    {
      name: "needs wins over everything and is listed once",
      assistants: [a("ada", "project"), a("bob")],
      teams: [t("g", ["ada", "bob"])],
      needs: ["ada"],
      expected: { needs: ["ada"], groups: [["g", ["bob"]]], projects: [], unassigned: [] },
    },
    {
      name: "an assistant in two groups shows under both, never as unassigned",
      assistants: [a("ada"), a("bob")],
      teams: [t("g1", ["ada"]), t("g2", ["ada", "bob"])],
      needs: [],
      expected: {
        needs: [],
        groups: [
          ["g1", ["ada"]],
          ["g2", ["ada", "bob"]],
        ],
        projects: [],
        unassigned: [],
      },
    },
    {
      name: "a group keeps showing with no members, and ignores unknown member ids",
      assistants: [a("ada")],
      teams: [t("empty", []), t("ghost", ["nobody"])],
      needs: [],
      expected: {
        needs: [],
        groups: [
          ["empty", []],
          ["ghost", []],
        ],
        projects: [],
        unassigned: ["ada"],
      },
    },
    {
      name: "project scoped assistants group by project; a grouped one stays in its group",
      assistants: [a("r1", "project", "p1"), a("r2", "project", "p2"), a("r3", "project", "p1")],
      teams: [t("g", ["r3"])],
      needs: [],
      expected: {
        needs: [],
        groups: [["g", ["r3"]]],
        projects: [
          ["p1", ["r1"]],
          ["p2", ["r2"]],
        ],
        unassigned: [],
      },
    },
  ])("$name", ({ assistants, teams, needs, expected }) => {
    const result = assistantSections({
      assistants,
      teams,
      needsKeys: new Set(needs.map((n) => `env:${n}`)),
    });
    expect({
      needs: ids(result.needs),
      groups: result.groups.map((g) => [g.team.team.id, ids(g.members)]),
      projects: result.projects.map((p) => [p.projectId, ids(p.members)]),
      unassigned: ids(result.unassigned),
    }).toEqual(expected);
  });
});
