import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type AccessAssistant,
  type AccessTeam,
  inheritedProjects,
  membersGainingAccess,
  ownProjectsWith,
  projectAccess,
  projectAccessBlocks,
  teamsEnvironmentLabels,
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
  it("adds or removes projects, but never its home one or on an everywhere assistant", () => {
    expect(ownProjectsWith(bo, [P("p4")], true)).toEqual(["p1", "p4"]);
    expect(ownProjectsWith(bo, [P("p4"), P("p5")], true)).toEqual(["p1", "p4", "p5"]);
    expect(ownProjectsWith(ana, [P("p1")], true)).toEqual(["p1", "p2"]);
    expect(ownProjectsWith(ana, [P("p2")], false)).toEqual(["p1"]);
    expect(ownProjectsWith(ana, [P("p1")], false)).toBeNull();
    expect(ownProjectsWith(ana, [P("p2"), P("p1")], false)).toBeNull();
    expect(ownProjectsWith(jarvis, [P("p1")], true)).toBeNull();
  });
});

describe("projectAccessBlocks", () => {
  const at = (environmentId: string, ...ids: ReadonlyArray<string>) =>
    ids.map((id) => ({
      environmentId: environmentId as never,
      id: P(id),
      environmentLabel: (environmentId === "mac2" ? "mac" : environmentId) as string | null,
      workspaceRoot: `/${environmentId === "mac2" ? "mac" : environmentId}/${id}`,
    }));
  const unnamed = (environmentId: string, id: string) => ({
    ...at(environmentId, id)[0]!,
    environmentLabel: null,
  });
  const elsewhere = (environmentId: string, id: string) => ({
    ...at(environmentId, id)[0]!,
    workspaceRoot: `/elsewhere/${id}`,
  });
  const entries = (environmentId: string) => ({
    assistants: [ana, bo, jarvis].map((assistant) => ({
      environmentId: environmentId as never,
      assistant,
    })),
    teams: teams.map((team) => ({ environmentId: environmentId as never, team })),
  });
  const mac = entries("mac");
  const both = {
    assistants: [...mac.assistants, ...entries("pc").assistants],
    teams: [...mac.teams, ...entries("pc").teams],
  };
  const sameHost = {
    assistants: [...both.assistants, ...entries("mac2").assistants],
    teams: [...both.teams, ...entries("mac2").teams],
  };

  it.each([
    ["one checkout", at("mac", "p3"), mac, [{ ids: ["p3"], title: null }]],
    [
      "two checkouts with the same access",
      at("mac", "p4", "p5"),
      mac,
      [{ ids: ["p4", "p5"], title: null }],
    ],
    [
      "two checkouts with different access",
      at("mac", "p3", "p4"),
      mac,
      [
        { ids: ["p3"], title: { environment: false, path: true, address: false } },
        { ids: ["p4"], title: { environment: false, path: true, address: false } },
      ],
    ],
    [
      "the same access in two environments",
      [...at("mac", "p3"), ...at("pc", "p3")],
      both,
      [
        { ids: ["p3"], title: { environment: true, path: false, address: false } },
        { ids: ["p3"], title: { environment: true, path: false, address: false } },
      ],
    ],
    [
      "equal checkouts grouped, the different one labelled, in first-seen order",
      [...at("mac", "p4", "p3"), ...at("pc", "p1"), ...at("mac", "p5")],
      both,
      [
        { ids: ["p4", "p5"], title: { environment: true, path: true, address: false } },
        { ids: ["p3"], title: { environment: true, path: true, address: false } },
        { ids: ["p1"], title: { environment: true, path: false, address: false } },
      ],
    ],
    [
      "two environments named alike, and a third named apart",
      [...at("mac", "p3"), elsewhere("mac2", "p3"), ...at("pc", "p3")],
      sameHost,
      [
        { ids: ["p3"], title: { environment: true, path: true, address: false } },
        { ids: ["p3"], title: { environment: true, path: true, address: false } },
        { ids: ["p3"], title: { environment: true, path: false, address: false } },
      ],
    ],
    [
      "two environments with the same name and path",
      [...at("mac", "p3"), ...at("mac2", "p3"), ...at("pc", "p3")],
      sameHost,
      [
        { ids: ["p3"], title: { environment: true, path: true, address: true } },
        { ids: ["p3"], title: { environment: true, path: true, address: true } },
        { ids: ["p3"], title: { environment: true, path: false, address: false } },
      ],
    ],
    [
      "two environments without a name",
      [unnamed("mac", "p3"), unnamed("pc", "p3")],
      both,
      [
        { ids: ["p3"], title: { environment: true, path: true, address: false } },
        { ids: ["p3"], title: { environment: true, path: true, address: false } },
      ],
    ],
    [
      "an environment without assistants",
      [...at("mac", "p3"), ...at("bare", "p3")],
      mac,
      [{ ids: ["p3"], title: null }],
    ],
  ])("%s", (_name, checkouts, { assistants, teams: teamEntries }, expected) => {
    const blocks = projectAccessBlocks(checkouts, assistants, teamEntries);
    expect(
      blocks.map((block) => ({
        ids: block.checkouts.map((checkout) => checkout.id),
        title: block.title,
      })),
    ).toEqual(expected);
  });
});

describe("teamsEnvironmentLabels", () => {
  const environments = new Map([
    ["mac", { label: "MacBook", address: "10.0.2.2:3773" }],
    ["dev", { label: "MacBook", address: "127.0.0.1:3773" }],
    ["pc", { label: "PC", address: "pc.local:3773" }],
  ]);
  const row = (environmentId: string, id: string, name: string) => ({
    environmentId: environmentId as EnvironmentId,
    assistant: { id, name },
  });
  it.each([
    ["one environment", [row("mac", "a", "Jarvis"), row("mac", "b", "Ana")], [null, null]],
    [
      "names that differ across environments",
      [row("mac", "a", "Jarvis"), row("pc", "b", "Jarvis")],
      ["MacBook", "PC"],
    ],
    [
      "the same name in two environments named alike",
      [row("mac", "a", "Jarvis"), row("dev", "a", "Jarvis"), row("dev", "b", "Ana")],
      ["10.0.2.2:3773", "127.0.0.1:3773", "MacBook"],
    ],
  ])("%s", (_name, rows, expected) => {
    const label = teamsEnvironmentLabels(rows, environments);
    expect(rows.map((entry) => label(entry.environmentId, entry.assistant.id))).toEqual(expected);
  });
});
