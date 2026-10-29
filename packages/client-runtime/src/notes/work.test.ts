import type { EnvironmentProject } from "../state/models.ts";
import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultWorkProject, workProjectOptions } from "./work.ts";

const project = (id: string, title: string, workspaceRoot: string, updatedAt: string) =>
  ({
    environmentId: EnvironmentId.make("env"),
    id: id as ProjectId,
    title,
    workspaceRoot,
    updatedAt,
  }) as EnvironmentProject;

const projects = [
  project("web", "Web", "/code/web", "2026-01-01T00:00:00.000Z"),
  project("api", "API", "/code/api", "2026-01-03T00:00:00.000Z"),
  project("api-old", "API", "/old/api", "2026-01-02T00:00:00.000Z"),
];

describe("start work project", () => {
  it("picks the project named like the note's folder, ignoring case", () => {
    expect(defaultWorkProject(projects, "web", ["api" as ProjectId])).toBe("web");
  });

  it("otherwise picks the most recently active project, then the most recently updated", () => {
    expect(defaultWorkProject(projects, "ideas", ["gone" as ProjectId, "web" as ProjectId])).toBe(
      "web",
    );
    expect(defaultWorkProject(projects, null, [])).toBe("api");
    expect(defaultWorkProject([], null, [])).toBe(null);
  });

  it("tells same-named projects apart by their folder", () => {
    expect(workProjectOptions(projects).map((option) => option.label)).toEqual([
      "API · /code/api",
      "API · /old/api",
      "Web",
    ]);
  });
});
