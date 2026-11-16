import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AccessAssistant,
  type AccessTeam,
  inheritedProjects,
  membersGainingAccess,
  ownProjectsWith,
  projectAccess,
} from "./assistantProjectAccess.ts";

const P = (id: string) => id as ProjectId;
const person = (
  id: string,
  projectIds: ReadonlyArray<string>,
  extra: Partial<AccessAssistant> = {},
): AccessAssistant =>
  ({
    id,
    name: id.toUpperCase(),
    scope: "project",
    projectId: projectIds[0] ?? "home",
    projectIds,
    archivedAt: null,
    ...extra,
  }) as AccessAssistant;
const group = (
  id: string,
  memberIds: ReadonlyArray<string>,
  projectIds: ReadonlyArray<string>,
  archivedAt: string | null = null,
): AccessTeam => ({ id, name: `Group ${id}`, memberIds, projectIds, archivedAt }) as AccessTeam;

const ana = person("ana", ["p1", "p2"]);
const bo = person("bo", ["p1"]);
const jarvis = person("jarvis", [], { scope: "all" });
const gone = person("gone", ["p1"], { archivedAt: "then" });
const dev = group("dev", ["ana", "bo", "jarvis", "gone"], ["p2", "p3"]);
const old = group("old", ["ana"], ["p9"], "then");
const teams = [dev, old];

describe("inheritedProjects", () => {
  it("lists active groups' projects with their group names and marks the ones it also owns", () => {
    expect(inheritedProjects(ana, teams)).toEqual([
      { projectId: "p2", teamNames: ["Group dev"], alsoOwn: true },
      { projectId: "p3", teamNames: ["Group dev"], alsoOwn: false },
    ]);
    expect(inheritedProjects(jarvis, teams)).toEqual([]);
  });
});

describe("membersGainingAccess", () => {
  it("counts active project members that cannot reach a picked project yet", () => {
    // ana reaches p1,p2,p3; bo reaches p1,p2,p3 through the group; jarvis and gone never count.
    expect(membersGainingAccess(dev, ["p3"], [ana, bo, jarvis, gone], teams)).toBe(0);
    expect(membersGainingAccess(dev, ["p4"], [ana, bo, jarvis, gone], teams)).toBe(2);
    const withoutGroup = [group("dev", dev.memberIds, [])];
    expect(membersGainingAccess(withoutGroup[0]!, ["p2"], [ana, bo], withoutGroup)).toBe(1);
  });
});

describe("projectAccess", () => {
  it("tells, per group and per assistant, how each reaches the project", () => {
    const access = projectAccess("p3", [ana, bo, jarvis, gone], teams);
    // "gone" is archived, so dev counts 3 members, not 4.
    expect(
      access.groups.map((row) => [row.team.id, row.granted, row.members, row.gainingMembers]),
    ).toEqual([["dev", true, 3, 0]]);
    expect(
      access.assistants.map((row) => [row.assistant.id, row.kind, row.viaTeams, row.isHome]),
    ).toEqual([
      ["ana", "group", ["Group dev"], false],
      ["bo", "group", ["Group dev"], false],
      ["jarvis", "everywhere", [], false],
    ]);
    expect(projectAccess("p1", [ana], teams).assistants[0]).toMatchObject({
      kind: "own",
      isHome: true,
    });
    expect(projectAccess("p4", [bo], teams).assistants[0]?.kind).toBe("none");
  });
});

describe("ownProjectsWith", () => {
  it("adds or removes a project, but never its home one or on an everywhere assistant", () => {
    expect(ownProjectsWith(bo, P("p4"), true)).toEqual(["p1", "p4"]);
    expect(ownProjectsWith(ana, P("p1"), true)).toEqual(["p1", "p2"]);
    expect(ownProjectsWith(ana, P("p2"), false)).toEqual(["p1"]);
    expect(ownProjectsWith(ana, P("p1"), false)).toBeNull();
    expect(ownProjectsWith(jarvis, P("p1"), true)).toBeNull();
  });
});
