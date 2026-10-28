import { describe, expect, it } from "vite-plus/test";

import { hideIdleFolderProjects } from "./projects.ts";

describe("hideIdleFolderProjects", () => {
  const projects = [
    { environmentId: "env", id: "app" },
    { environmentId: "env", id: "root" },
    { environmentId: "env", id: "tmp" },
  ];

  it("hides a folder until it holds a thread or draft and keeps ordinary projects", () => {
    const folders = new Set(["env:root", "env:tmp"]);
    expect(
      hideIdleFolderProjects(projects, folders, new Set(["env:tmp"])).map((p) => p.id),
    ).toEqual(["app", "tmp"]);
  });
});
