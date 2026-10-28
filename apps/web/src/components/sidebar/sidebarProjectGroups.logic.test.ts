import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planSidebarThreadDrop,
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
} from "../Sidebar.logic";
import {
  buildProjectListItems,
  groupListItemsByScope,
  groupThreadsByProject,
  isProjectDragId,
  projectDragId,
  projectKeyFromDragId,
  resolveVisibleProjectThreads,
} from "./sidebarProjectGroups.logic";

const environmentId = EnvironmentId.make("environment-local");
const alpha = ProjectId.make("alpha");
const beta = ProjectId.make("beta");
const groups = [
  { projectKey: "alpha", memberProjects: [{ environmentId, id: alpha }] },
  { projectKey: "beta", memberProjects: [{ environmentId, id: beta }] },
];
const thread = (id: string, projectId: ProjectId) => ({ id, environmentId, projectId });

describe("groupThreadsByProject", () => {
  it("keeps project order, pinned first, and settled threads out of the open list", () => {
    const result = groupThreadsByProject({
      groups,
      pinned: [thread("pin", beta)],
      unsettled: [thread("a1", alpha), thread("b1", beta)],
      settled: [thread("s2", alpha), thread("s1", alpha)],
    });
    expect(result.map((group) => group.projectKey)).toEqual(["alpha", "beta"]);
    expect(result[0]?.openThreads.map((t) => t.id)).toEqual(["a1"]);
    expect(result[0]?.settledThreads.map((t) => t.id)).toEqual(["s2", "s1"]);
    expect(result[1]?.openThreads.map((t) => t.id)).toEqual(["pin", "b1"]);
    expect(result[1]?.settledThreads).toEqual([]);
  });

  it("drops threads of unknown projects", () => {
    const result = groupThreadsByProject({
      groups,
      pinned: [],
      unsettled: [thread("x", ProjectId.make("gone"))],
      settled: [],
    });
    expect(result.flatMap((group) => group.openThreads)).toEqual([]);
  });
});

describe("resolveVisibleProjectThreads", () => {
  const group = {
    projectKey: "alpha",
    openThreads: [thread("a1", alpha), thread("a2", alpha)],
    settledThreads: [thread("s1", alpha), thread("s2", alpha), thread("s3", alpha)],
  };
  const resolve = (overrides: {
    expanded?: boolean;
    settledExpanded?: boolean;
    routeThreadKey?: string | null;
  }) => {
    const visible = resolveVisibleProjectThreads({
      group,
      getKey: (t) => t.id,
      expanded: true,
      settledExpanded: false,
      settledLimit: 2,
      routeThreadKey: null,
      ...overrides,
    });
    return { open: visible.open.map((t) => t.id), settled: visible.settled.map((t) => t.id) };
  };

  it("hides collapsed settled threads and pages expanded ones", () => {
    expect(resolve({})).toEqual({ open: ["a1", "a2"], settled: [] });
    expect(resolve({ settledExpanded: true })).toEqual({
      open: ["a1", "a2"],
      settled: ["s1", "s2"],
    });
  });

  it("keeps the route thread reachable when its group or shelf is collapsed", () => {
    expect(resolve({ expanded: false, routeThreadKey: "a2" })).toEqual({
      open: ["a2"],
      settled: [],
    });
    expect(resolve({ routeThreadKey: "s3", settledExpanded: true }).settled).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });
});

describe("project list drops", () => {
  const items = buildProjectListItems({
    scope: "alpha",
    open: [
      { key: "p1", section: "pinned" },
      { key: "a1", section: "active" },
      { key: "a2", section: "active" },
    ],
    settledKeys: ["s1"],
  });
  const plan = (activeKey: string, overId: string) => {
    const target = resolveSidebarDropTarget(items, activeKey, overId);
    if (target === null) return null;
    const section = items.find((item) => item.kind === "thread" && item.key === activeKey);
    return planSidebarThreadDrop({
      activeKey,
      activeSection: section?.kind === "thread" ? section.section : "active",
      supportsSettlement: true,
      target,
      pinnedOrder: ["p1"],
      pinnedKeysById: new Map([["p1", "a"]]),
      activeOrder: ["a1", "a2"],
      activeKeysById: new Map(),
      activeTimeOrdered: true,
    }).kind;
  };

  it("pins when an open thread lands on the pinned row", () => {
    expect(plan("a1", "p1")).toBe("pin");
  });

  it("unpins when a pinned thread lands on an open row", () => {
    expect(plan("p1", "a2")).toBe("move-active");
  });

  it("settles on the Settled zone and unsettles back into the open list", () => {
    expect(plan("a1", sidebarMarkerId("settled-placeholder", "alpha"))).toBe("settle");
    expect(plan("a1", "s1")).toBe("settle");
    expect(plan("s1", "a2")).toBe("move-active");
  });

  it("keeps ids unique across projects and rejects drops on another project", () => {
    const beta = buildProjectListItems({ scope: "beta", open: [], settledKeys: [] });
    const ids = [...items, ...beta].map(sidebarListItemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(resolveSidebarDropTarget(items, "a1", sidebarListItemId(beta[0]!))).toBeNull();
    expect(groupListItemsByScope([...items, ...beta]).get("beta")).toEqual(beta);
  });

  it("round-trips project drag ids", () => {
    expect(isProjectDragId(projectDragId("alpha"))).toBe(true);
    expect(isProjectDragId("thread-key")).toBe(false);
    expect(projectKeyFromDragId(projectDragId("alpha"))).toBe("alpha");
  });
});
