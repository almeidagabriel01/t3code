import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  resolveSettingsScope,
  settingsScopeProjectKeys,
  settingsScopeProjectValue,
  validateSettingsScopeSearch,
} from "./settingsScope";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "Laptop" },
  { environmentId: serverId, label: "Server" },
];

function member(id: string, environmentId: EnvironmentId): SidebarProjectGroupMember {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "T3 Code",
    workspaceRoot: `/repos/${id}`,
    physicalProjectKey: `${environmentId}:/repos/${id}`,
    environmentLabel:
      environments.find((environment) => environment.environmentId === environmentId)?.label ??
      null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const first = member("first", laptopId);
const second = member("second", laptopId);
const third = member("third", serverId);
const other = member("other", serverId);

function group(
  projectKey: string,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  return {
    ...members[0]!,
    projectKey,
    displayName: projectKey,
    memberProjects: members,
    memberProjectRefs: members.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
    groupedProjectCount: members.length,
    environmentPresence: "mixed",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    remoteEnvironmentLabels: [],
    pinned: false,
    archived: false,
  };
}

const groups = [group("t3code", [first, second, third]), group("other", [other])];

describe("settings scope search", () => {
  it.each([
    [["a", "b"], '["a","b"]'],
    [["a", 3, " ", "a"], "a"],
    [[], undefined],
  ])("reads a project list the router already parsed (%j)", (project, expected) => {
    expect(validateSettingsScopeSearch({ project }).project).toBe(expected);
  });

  it("retains an orphan checkout so it cannot turn into all environments", () => {
    const search = validateSettingsScopeSearch({ checkout: first.physicalProjectKey });
    expect(search).toEqual({ checkout: first.physicalProjectKey });
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      reason: "project-required",
      members: [],
      environmentIds: [],
    });
  });
});

describe("settings scope resolution", () => {
  it("keeps all physical members in a project aggregate, including several on one environment", () => {
    expect(resolveSettingsScope({ project: "t3code" }, groups, environments)).toMatchObject({
      kind: "project",
      environmentId: null,
      members: [first, second, third],
      environmentIds: [laptopId, serverId],
    });
  });

  it("narrows a checkout target to exactly one member, deriving its environment when omitted", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: second.physicalProjectKey },
        groups,
        environments,
      ),
    ).toMatchObject({
      kind: "checkout",
      checkout: second,
      environmentId: laptopId,
      label: "t3code / Laptop · /repos/second",
      members: [second],
      environmentIds: [laptopId],
    });
  });

  it.each([
    { project: "missing" },
    { machine: "removed" },
    { project: "t3code", machine: "removed" },
    { project: "t3code", checkout: "deleted" },
    { project: "other", machine: laptopId },
    { project: "other", checkout: first.physicalProjectKey },
    { project: "t3code", machine: serverId, checkout: first.physicalProjectKey },
  ])("never widens an invalid or stale target: %j", (search) => {
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("leaves a removed checkout unavailable while sibling checkouts remain", () => {
    const search = {
      project: "t3code",
      machine: laptopId,
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "checkout",
      members: [first],
    });
    expect(
      resolveSettingsScope(search, [group("t3code", [second, third])], environments),
    ).toMatchObject({ kind: "unavailable", members: [], environmentIds: [] });
  });

  it("does not select another environment after removing a project's last local checkout", () => {
    const search = { project: "t3code", machine: laptopId };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      members: [first, second],
    });
    expect(resolveSettingsScope(search, [group("t3code", [third])], environments)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
    });
  });

  it("rejects a cached checkout whose environment was removed", () => {
    expect(
      resolveSettingsScope(
        { project: "t3code", checkout: third.physicalProjectKey },
        groups,
        environments.slice(0, 1),
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      members: [],
      environmentIds: [],
    });
  });
});

describe("several projects in one scope", () => {
  it.each([
    [undefined, []],
    ["t3code", ["t3code"]],
    ['["a","b"]', ["a", "b"]],
    ['["a","a"]', ["a"]],
    ["[broken", ["[broken"]],
    ['["a",1]', ['["a",1]']],
    ["[]", ["[]"]],
    ["[team] app", ["[team] app"]],
  ])("reads project keys from %j", (project, keys) => {
    expect(settingsScopeProjectKeys({ project })).toEqual(keys);
  });

  it.each([
    [[], undefined],
    [["a"], "a"],
    [["a", "b"], '["a","b"]'],
    [["a", "b", "a"], '["a","b"]'],
  ])("writes project keys %j", (keys, value) => {
    expect(settingsScopeProjectValue(keys)).toBe(value);
  });

  it("joins the members of every project, ignoring a checkout", () => {
    const search = {
      project: settingsScopeProjectValue(["t3code", "other"]),
      checkout: first.physicalProjectKey,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      group: { projectKey: "t3code" },
      groups: [{ projectKey: "t3code" }, { projectKey: "other" }],
      label: "t3code, other / All checkouts",
      members: [first, second, third, other],
      environmentIds: [laptopId, serverId],
    });
  });

  it("filters by environment and drops projects that no longer exist", () => {
    const search = {
      project: settingsScopeProjectValue(["t3code", "gone", "other"]),
      machine: serverId,
    };
    expect(resolveSettingsScope(search, groups, environments)).toMatchObject({
      kind: "project",
      label: "t3code, other / Server",
      members: [third, other],
      environmentIds: [serverId],
    });
  });

  it("counts projects past two and keeps one project's group list", () => {
    const three = [group("a", [first]), group("b", [second]), group("c", [third])];
    expect(
      resolveSettingsScope(
        { project: settingsScopeProjectValue(["a", "b", "c"]) },
        three,
        environments,
      ),
    ).toMatchObject({ label: "3 projects / All checkouts" });
    expect(resolveSettingsScope({ project: "a" }, three, environments)).toMatchObject({
      groups: [{ projectKey: "a" }],
    });
  });

  it("is unavailable when every project is gone or none has a checkout there", () => {
    expect(
      resolveSettingsScope(
        { project: settingsScopeProjectValue(["x", "y"]) },
        groups,
        environments,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "project-missing", members: [] });
    expect(
      resolveSettingsScope(
        { project: settingsScopeProjectValue(["other", "gone"]), machine: laptopId },
        groups,
        environments,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "checkout-missing", members: [] });
    expect(
      resolveSettingsScope(
        { project: settingsScopeProjectValue(["other", "t3code"]), machine: "none" },
        groups,
        environments,
      ),
    ).toMatchObject({ kind: "unavailable", reason: "environment-missing" });
  });
});
