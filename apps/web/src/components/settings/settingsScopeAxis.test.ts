import { describe, expect, it } from "vite-plus/test";

import {
  projectAxisValues,
  selectEnvironmentAxis,
  selectProjectAxis,
  toggleProjectAxis,
} from "./settingsScopeAxis";

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });

  it.each([
    [{}, "a", { project: "a" }],
    [{ project: "a" }, "b", { project: '["a","b"]' }],
    [{ project: '["a","b"]', machine: "m" }, "a", { project: "b", machine: "m" }],
    [{ project: "a", checkout: "c" }, "all", {}],
    [{ project: "a" }, "a", {}],
    [{ project: '["a","b"]' }, "b", { project: "a" }],
  ])("toggles a project in the selection: %j + %s", (search, value, expected) => {
    expect(toggleProjectAxis(search, value)).toEqual(expected);
  });

  it("reports all projects as the selection when none is chosen", () => {
    expect(projectAxisValues({})).toEqual(["all"]);
    expect(projectAxisValues({ project: '["a","b"]' })).toEqual(["a", "b"]);
  });
});
