import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildArchivedProjectItems } from "./archivedThreadList";

const hub = EnvironmentId.make("hub");
const lab = EnvironmentId.make("lab");

function project(
  id: string,
  title: string,
  environmentId: EnvironmentId,
  archivedAt: string | null,
) {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/w/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt,
  } as EnvironmentProject;
}

const projects = [
  project("a", "Alpha", hub, "2026-06-02T00:00:00.000Z"),
  project("b", "Beta", hub, null),
  project("c", "Gamma", lab, "2026-06-02T00:00:00.000Z"),
];

describe("buildArchivedProjectItems", () => {
  it.each([
    { environmentId: null, searchQuery: "", titles: ["Alpha", "Gamma"] },
    { environmentId: hub, searchQuery: "", titles: ["Alpha"] },
    { environmentId: null, searchQuery: " gam ", titles: ["Gamma"] },
    { environmentId: null, searchQuery: "beta", titles: [] },
  ])("env=$environmentId query=$searchQuery", ({ environmentId, searchQuery, titles }) => {
    const items = buildArchivedProjectItems({
      projects,
      environmentId,
      projectGroupingMode: "separate",
      searchQuery,
    });
    expect(items.map((item) => item.title).toSorted()).toEqual(titles);
    for (const item of items) expect(item.projectRefs.length).toBeGreaterThan(0);
  });
});
