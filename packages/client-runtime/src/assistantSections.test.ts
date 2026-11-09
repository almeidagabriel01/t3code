import { describe, expect, it } from "vite-plus/test";

import {
  assistantProjectFields,
  assistantProjectSelection,
  assistantSections,
  homeAfterPick,
  sameProjects,
  toggleAssistantProject,
  projectAssistants,
  type SectionAssistant,
  type SectionTeam,
} from "./assistantSections.ts";

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

describe("an assistant over several projects", () => {
  const multi = {
    environmentId: "env",
    assistant: {
      id: "ada",
      scope: "project",
      projectId: "p1",
      projectIds: ["p1", "p2"],
    } as unknown as SectionAssistant["assistant"],
  };
  it("is listed under every project on its list", () => {
    const result = assistantSections({ assistants: [multi], teams: [], needsKeys: new Set() });
    expect(result.projects.map((p) => [p.projectId, ids(p.members)])).toEqual([
      ["p1", ["ada"]],
      ["p2", ["ada"]],
    ]);
  });
  it("shows its face in each listed project and none elsewhere", () => {
    const among = (projectId: string) =>
      ids(projectAssistants([multi], [{ environmentId: "env", projectId }]));
    expect([among("p1"), among("p2"), among("p3")]).toEqual([["ada"], ["ada"], []]);
  });
});

describe("projectAssistants", () => {
  const b = (id: string, scope: "all" | "project", projectId: string, environmentId = "env") => ({
    ...a(id, scope, projectId),
    environmentId,
  });
  it.each([
    { name: "keeps project scope of the member", members: [["env", "p1"]], expected: ["ada"] },
    { name: "ignores other projects", members: [["env", "p9"]], expected: [] },
    { name: "matches the environment too", members: [["other", "p1"]], expected: [] },
    {
      name: "any member of a merged project counts",
      members: [
        ["other", "p1"],
        ["env2", "p2"],
      ],
      expected: ["cy"],
    },
    { name: "no members", members: [], expected: [] },
  ])("$name", ({ members, expected }) => {
    const entries = [
      b("ada", "project", "p1"),
      b("bob", "all", "p1"),
      b("cy", "project", "p2", "env2"),
    ];
    const result = projectAssistants(
      entries,
      members.map(([environmentId, projectId]) => ({
        environmentId: environmentId!,
        projectId: projectId!,
      })),
    );
    expect(ids(result)).toEqual(expected);
  });
});

function multiOf(scope: "all" | "project", projectIds: string[]) {
  return {
    id: "x",
    scope,
    projectId: "p1",
    projectIds,
  } as unknown as SectionAssistant["assistant"];
}

describe("the project pick", () => {
  it.each([
    { name: "adds a project", cur: ["p1"], id: "p2", expected: ["p1", "p2"] },
    { name: "removes a project", cur: ["p1", "p2"], id: "p1", expected: ["p2"] },
    { name: "all is exclusive", cur: ["p1", "p2"], id: "all", expected: ["all"] },
    { name: "a project replaces all", cur: ["all"], id: "p1", expected: ["p1"] },
    { name: "clearing the last falls back to all", cur: ["p1"], id: "p1", expected: ["all"] },
  ])("$name", ({ cur, id, expected }) => {
    expect(toggleAssistantProject(cur, "all", id)).toEqual(expected);
  });
  it("has no fallback when there is no all entry", () => {
    expect(toggleAssistantProject(["p1"], null, "p1")).toEqual([]);
  });
  it("starts on the list, or the home of an assistant for every project", () => {
    expect(assistantProjectSelection(multiOf("project", ["p1", "p2"]))).toEqual(["p1", "p2"]);
    expect(assistantProjectSelection(multiOf("project", []))).toEqual(["p1"]);
    expect(assistantProjectSelection(multiOf("all", []))).toEqual(["p1"]);
  });
  it("keeps the home while it stays picked", () => {
    expect([homeAfterPick("p1", ["p2", "p1"]), homeAfterPick("p1", ["p2"])]).toEqual(["p1", "p2"]);
    expect(homeAfterPick(null, [])).toBeNull();
  });
  it("sends one project as projectId and several as a list", () => {
    expect(assistantProjectFields(["p1"])).toEqual({ projectId: "p1" });
    expect(assistantProjectFields(["p1", "p2"])).toEqual({
      projectId: "p1",
      projectIds: ["p1", "p2"],
    });
  });
  it("compares picks as sets", () => {
    expect([sameProjects(["a", "b"], ["b", "a"]), sameProjects(["a"], ["a", "b"])]).toEqual([
      true,
      false,
    ]);
  });
});
