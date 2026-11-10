import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  selectedProjectGroupsOf,
  settingsProjectsLabel,
  settingsTargetsForProject,
  toggleSettingsProject,
} from "./settings-environment-filter.logic";

const group = (key: string) => ({ key, label: key.toUpperCase() });

describe("toggleSettingsProject", () => {
  it("adds, removes, and returns to all projects when the last one is cleared", () => {
    const one = toggleSettingsProject(null, "a");
    expect([...one!]).toEqual(["a"]);
    const two = toggleSettingsProject(one, "b");
    expect([...two!]).toEqual(["a", "b"]);
    expect([...toggleSettingsProject(two, "a")!]).toEqual(["b"]);
    expect(toggleSettingsProject(one, "a")).toBeNull();
  });
});

describe("selectedProjectGroupsOf", () => {
  const groups = [group("a"), group("b"), group("c")];

  it.each([
    [null, null],
    [
      ["a", "c"],
      ["a", "c"],
    ],
    [["b", "gone"], ["b"]],
    [["gone"], []],
  ] as const)("resolves %j to %j", (keys, expected) => {
    const resolved = selectedProjectGroupsOf(groups, keys === null ? null : new Set(keys));
    expect(resolved === null ? null : resolved.map((entry) => entry.key)).toEqual(expected);
  });
});

describe("settingsProjectsLabel", () => {
  it.each([
    [null, "All projects"],
    [[], "Unavailable project"],
    [[group("a")], "A"],
    [[group("a"), group("b")], "2 projects"],
  ] as const)("labels %j as %s", (groups, label) => {
    expect(settingsProjectsLabel(groups)).toBe(label);
  });
});

describe("settingsTargetsForProject", () => {
  const targets = ["x", "y", "z"].map((id) => ({ environmentId: id as EnvironmentId }));

  it("keeps the environments that hold any selected project", () => {
    const projects = [
      { environmentId: "x" as EnvironmentId },
      { environmentId: "z" as EnvironmentId },
    ];
    expect(settingsTargetsForProject(targets, projects)).toEqual([targets[0], targets[2]]);
    expect(settingsTargetsForProject(targets, null)).toBe(targets);
    expect(settingsTargetsForProject(targets, [])).toEqual([]);
  });
});
