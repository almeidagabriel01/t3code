import { describe, expect, it } from "vite-plus/test";

import type { ProjectManagedRole } from "@t3tools/contracts";

import { hideIdleFolderProjects, isAssistantHomeProject, isScratchProject } from "./projects.ts";

describe("managed project classification", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly workspaceRoot: string;
    readonly managedRole?: ProjectManagedRole;
    readonly scratchRoot: string | null;
    readonly scratch: boolean;
    readonly home: boolean;
  }> = [
    {
      name: "online scratch",
      workspaceRoot: "/t3/scratch",
      managedRole: "scratch",
      scratchRoot: "/t3/scratch",
      scratch: true,
      home: true,
    },
    {
      name: "offline scratch with no cached config",
      workspaceRoot: "/t3/scratch",
      managedRole: "scratch",
      scratchRoot: null,
      scratch: true,
      home: true,
    },
    {
      name: "assistants' fallback home",
      workspaceRoot: "/t3/assistants",
      managedRole: "assistants",
      scratchRoot: null,
      scratch: false,
      home: true,
    },
    {
      name: "legacy record matched by the live config",
      workspaceRoot: "/t3/scratch",
      scratchRoot: "/t3/scratch/",
      scratch: true,
      home: true,
    },
    {
      name: "legacy record with no config",
      workspaceRoot: "/t3/scratch",
      scratchRoot: null,
      scratch: false,
      home: false,
    },
    {
      name: "ordinary project",
      workspaceRoot: "/repo",
      scratchRoot: "/t3/scratch",
      scratch: false,
      home: false,
    },
  ];

  it.each(cases)("$name", ({ workspaceRoot, managedRole, scratchRoot, scratch, home }) => {
    const project = { workspaceRoot, ...(managedRole ? { managedRole } : {}) };
    const isScratch = isScratchProject(project, scratchRoot);
    expect(isScratch).toBe(scratch);
    expect(
      isAssistantHomeProject({ ...project, ...(isScratch ? { isScratch: true as const } : {}) }),
    ).toBe(home);
  });
});

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
